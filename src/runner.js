// Runner: orchestrator that picks up pending acts from WarpMetrics,
// runs executors, records outcomes, emits next acts, syncs board.
// All adapters injected via constructor.

import { GRAPH, ACT_EXECUTOR, RESULT_EDGES, RESULT_OUTCOMES, BOARD_COLUMNS } from './machine.js';
import { OUTCOMES } from './names.js';

// ---------------------------------------------------------------------------
// resolveContainer — maps an 'in' label to a container ID.
//
// 'Issue'        → the Issue Run (run.id)
// '<group label>'→ the group with that label (from run.groups map)
// omitted        → Issue Run (run.id)
// ---------------------------------------------------------------------------

function resolveContainer(inLabel, run, logFn) {
  if (!inLabel || inLabel === 'Issue') return run.id;
  const groupId = run.groups?.get(inLabel);
  if (!groupId) {
    logFn?.(run.issueId, `warning: group "${inLabel}" not found, falling back to Issue Run`);
    return run.id;
  }
  return groupId;
}

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

export function createRunner({ warp, board, codehost, config, execute, effects, findDeployBatch, log: logFn }) {
  const repoNames = config.repoNames;
  const apiKey = config.warpmetricsApiKey;
  const concurrency = config.concurrency || 1;
  const inFlight = new Map();

  function log(issueId, msg) {
    logFn?.(issueId, msg);
  }

  // -------------------------------------------------------------------------
  // Pipeline telemetry helpers.
  // -------------------------------------------------------------------------

  async function startPipeline(executorName, run, act) {
    if (!apiKey) return null;
    try {
      const pNode = GRAPH[act.name];
      const p = await warp.startPipeline(apiKey, {
        step: executorName, label: pNode?.label,
        repo: run.repo, issueNumber: run.issueId,
        issueTitle: run.title, refActId: act.id,
      });
      log(run.issueId, `pipeline: run=${p.runId}`);
      return p.runId;
    } catch (err) {
      log(run.issueId, `warning: pipeline start failed: ${err.message}`);
      return null;
    }
  }

  async function finishPipeline(pipelineRunId, executorName, run, result) {
    if (!apiKey || !pipelineRunId) return;
    if (result.trace) {
      try { await warp.traceClaudeCall(apiKey, pipelineRunId, result.trace); } catch {}
    }
    try {
      await warp.recordOutcome(apiKey, { runId: pipelineRunId }, {
        step: executorName, success: result.type !== 'error',
        costUsd: result.costUsd, error: result.type === 'error' ? result.error : undefined,
        ...result.outcomeOpts,
      });
    } catch (err) {
      log(run.issueId, `warning: outcome recording failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // processRun — the core act-driven step
  // -------------------------------------------------------------------------

  async function processRun(run) {
    let act = run.pendingAct;
    if (!act) return;

    // Loop: process the current act, then immediately continue to the next
    // act if one was emitted. Breaks on terminal outcomes, waiting, or errors.
    // This eliminates 30s poll waits between fast inline transitions while
    // keeping the poll interval for external state (board, new issues, aborts).
    while (act) {
      const node = GRAPH[act.name];

      // Phase group auto-transition: create group, record outcome, emit first work act.
      if (node && node.executor === null) {
        const phaseResult = Object.values(node.results)[0];
        const outcomes = normalizeOutcomes(phaseResult.outcomes);
        const lastOutcome = outcomes[outcomes.length - 1];
        let nextActId = null;

        if (apiKey) {
          try {
            const containerId = run.id;
            const { groupId } = await warp.createGroup(apiKey, {
              runId: containerId, label: node.label,
            });
            if (!run.groups) run.groups = new Map();
            run.groups.set(node.label, groupId);

            for (const oc of outcomes) {
              const { outcomeId } = await warp.recordIssueOutcome(apiKey, { runId: groupId, name: oc.name });
              if (oc.next) {
                const { actId } = await warp.emitAct(apiKey, { outcomeId, name: oc.next, opts: act.opts });
                nextActId = actId;
              }
            }

            await warp.recordIssueOutcome(apiKey, { runId: run.id, name: lastOutcome.name });
            log(run.issueId, `phase: ${node.label}`);
          } catch (err) {
            log(run.issueId, `warning: phase group failed: ${err.message}`);
            break;
          }
        }

        if (board && run.boardItem) {
          const column = BOARD_COLUMNS[lastOutcome.name];
          if (column) {
            try { await board.syncState(run.boardItem, column); } catch (err) {
              log(run.issueId, `warning: board sync to ${column} failed: ${err.message}`);
            }
          }
        }

        // Continue to the emitted work act.
        if (lastOutcome.next) {
          run.latestOutcome = lastOutcome.name;
          act = { id: nextActId, name: lastOutcome.next, opts: act.opts };
          continue;
        }
        break;
      }

      // Work act execution.
      const executorName = ACT_EXECUTOR[act.name];
      if (!executorName || !execute[executorName]) break;

      // Skip board sync and pipeline for waiting-capable executors — they poll
      // every cycle and must not override manual board moves.
      const canWait = Object.keys(node.results).includes('waiting');

      // Board sync: in-progress before executing.
      if (!canWait && board && run.boardItem) {
        const column = BOARD_COLUMNS[run.latestOutcome];
        if (column) {
          try { await board.syncState(run.boardItem, column); } catch (err) {
            log(run.issueId, `warning: board sync to ${column} failed: ${err.message}`);
          }
        }
      }

      // Pre-compute deploy batch if applicable.
      let extraContext = {};
      if (executorName === 'deploy' && findDeployBatch) {
        try {
          extraContext.deployBatch = await findDeployBatch(run, act);
        } catch (err) {
          log(run.issueId, `warning: batch failed: ${err.message}`);
        }
      }

      // Step 1: Create pipeline run (visible immediately).
      let pipelineRunId = canWait ? null : await startPipeline(executorName, run, act);

      // Step 2: Execute.
      const result = await execute[executorName](run, { codehost, config, repoNames, log: (msg) => log(run.issueId, msg), actOpts: act.opts, ...extraContext });

      // Waiting = no-op — pending act stays unchanged, no telemetry or board sync.
      if (result.type === 'waiting') break;

      // Create pipeline retroactively for waiting-capable executors that resolved.
      if (!pipelineRunId) pipelineRunId = await startPipeline(executorName, run, act);

      // Step 3: Record outcome.
      await finishPipeline(pipelineRunId, executorName, run, result);

      // Route outcomes + emit next act using RESULT_EDGES.
      const resultKey = `${executorName}:${result.type}`;
      const edges = RESULT_EDGES[resultKey];
      let nextAct = null;

      if (edges && apiKey) {
        try {
          let recordedOnIssueRun = false;
          for (const edge of edges) {
            const containerId = resolveContainer(edge.in, run, log);
            if (containerId === run.id) recordedOnIssueRun = true;

            const { outcomeId } = await warp.recordIssueOutcome(apiKey, {
              runId: containerId, name: edge.name, opts: result.outcomeOpts,
            });

            if (edge.next && outcomeId) {
              const nao = result.nextActOpts || {};
              const { actId } = await warp.emitAct(apiKey, {
                outcomeId, name: edge.next, opts: nao,
              });
              nextAct = { id: actId, name: edge.next, opts: nao };
            }
          }

          if (!recordedOnIssueRun) {
            const boardOutcome = edges[edges.length - 1].name;
            await warp.recordIssueOutcome(apiKey, { runId: run.id, name: boardOutcome });
          }
        } catch (err) {
          log(run.issueId, `warning: outcome/act failed: ${err.message}`);
        }
      }

      // Side effects.
      if (effects[resultKey]) {
        try {
          await effects[resultKey](run, result, { codehost, config, repoNames, warp, apiKey, board, log: (msg) => log(run.issueId, msg) });
        } catch (err) {
          log(run.issueId, `warning: effect failed: ${err.message}`);
        }
      }

      // Board sync: post-execution.
      const boardOutcome = RESULT_OUTCOMES[resultKey];
      if (board && run.boardItem) {
        const column = BOARD_COLUMNS[boardOutcome];
        if (column) {
          try {
            await board.syncState(run.boardItem, column);
            log(run.issueId, `board: ${column}`);
          } catch (err) {
            log(run.issueId, `warning: board sync to ${column} failed: ${err.message}`);
          }
        }
      }
      if (boardOutcome) run.latestOutcome = boardOutcome;

      // Continue to next act if one was emitted and it's a forward
      // transition (different act). Retries (same act name) wait for
      // the next poll cycle so external state can change.
      if (!nextAct || nextAct.name === act.name) break;
      act = nextAct;
    }
  }

  // -------------------------------------------------------------------------
  // poll — one cycle of intake + processing
  // -------------------------------------------------------------------------

  async function poll({ onStep, onClearStep } = {}) {
    // Fetch open runs first so intake can dedup.
    let openRuns = [];
    if (apiKey) {
      try {
        openRuns = await warp.findOpenIssueRuns(apiKey);
      } catch (err) {
        log(null, `warning: could not fetch open runs: ${err.message}`);
        return { total: 0, processing: 0, inFlight: inFlight.size };
      }
    }

    // Intake: discover new issues from board, skip those with existing runs.
    if (board) {
      try {
        const existingIssueIds = new Set(openRuns.map(r => r.issueId));
        const newIssues = await board.scanNewIssues();
        for (const issue of newIssues) {
          if (existingIssueIds.has(issue.issueId)) continue;
          if (apiKey) {
            try {
              const { runId } = await warp.createIssueRun(apiKey, {
                repo: issue.repo || repoNames[0], issueNumber: issue.issueId, issueTitle: issue.title,
              });
              openRuns.push({
                id: runId, issueId: issue.issueId, repo: issue.repo, title: issue.title,
                latestOutcome: 'Started',
                pendingAct: { id: 'intake', name: 'Build', opts: { repo: issue.repo || repoNames[0], issue: String(issue.issueId), title: issue.title } },
              });
              log(issue.issueId, `new issue run: ${runId}`);
            } catch (err) {
              log(issue.issueId, `warning: issue run creation failed: ${err.message}`);
            }
          }
        }
      } catch (err) {
        log(null, `warning: board scan failed: ${err.message}`);
      }
    }

    // If board present, attach board items to runs for syncing.
    if (board) {
      try {
        const boardItems = await board.getAllItems();
        const itemsByIssueId = new Map();
        for (const item of boardItems) {
          if (item._issueId) itemsByIssueId.set(item._issueId, item);
        }
        for (const run of openRuns) {
          if (run.issueId && itemsByIssueId.has(run.issueId)) {
            run.boardItem = itemsByIssueId.get(run.issueId);
          }
        }
      } catch {}
    }

    // Abort: if a run's issue is in the board's Aborted column, close the run.
    if (board?.scanAborted && apiKey) {
      try {
        const abortedIds = await board.scanAborted();
        if (abortedIds.size > 0) {
          for (let i = openRuns.length - 1; i >= 0; i--) {
            const run = openRuns[i];
            if (!run.issueId || !abortedIds.has(run.issueId)) continue;
            try {
              await warp.recordIssueOutcome(apiKey, { runId: run.id, name: OUTCOMES.ABORTED });
              log(run.issueId, `aborted (moved to Aborted column)`);
            } catch (err) {
              log(run.issueId, `warning: abort failed: ${err.message}`);
            }
            openRuns.splice(i, 1);
          }
        }
      } catch {}
    }

    // Done: if a run's issue is manually moved to Done, close the run.
    if (board?.scanDone && apiKey) {
      try {
        const doneIds = await board.scanDone();
        if (doneIds.size > 0) {
          for (let i = openRuns.length - 1; i >= 0; i--) {
            const run = openRuns[i];
            if (!run.issueId || !doneIds.has(run.issueId)) continue;
            try {
              await warp.recordIssueOutcome(apiKey, { runId: run.id, name: OUTCOMES.SHIPPED });
              log(run.issueId, `shipped (moved to Done column)`);
            } catch (err) {
              log(run.issueId, `warning: ship failed: ${err.message}`);
            }
            openRuns.splice(i, 1);
          }
        }
      } catch {}
    }

    // Process waiting-capable acts first (await_deploy, await_reply) — they
    // resolve instantly and should not consume concurrency slots.
    const ready = openRuns.filter(r => r.issueId && !inFlight.has(r.issueId) && r.pendingAct);
    const waitingActs = [];
    const workActs = [];
    for (const run of ready) {
      const node = GRAPH[run.pendingAct.name];
      const executorName = ACT_EXECUTOR[run.pendingAct.name];
      const isWaiting = node && executorName && Object.keys(node.results).includes('waiting');
      (isWaiting ? waitingActs : workActs).push(run);
    }

    const maxWaiting = Math.max(concurrency * 5, 10);
    for (const run of waitingActs.slice(0, maxWaiting)) {
      await processRun(run);
    }

    // Launch work acts into available slots.
    const available = concurrency - inFlight.size;
    const toProcess = workActs.slice(0, available);

    for (const run of toProcess) {
      onStep?.(run.issueId, run.pendingAct.name);
      const promise = processRun(run)
        .catch(err => log(run.issueId, `task error: ${err.message}`))
        .finally(() => {
          inFlight.delete(run.issueId);
          onClearStep?.(run.issueId);
        });
      inFlight.set(run.issueId, promise);
    }

    return { total: openRuns.length, processing: toProcess.length, inFlight: inFlight.size };
  }

  async function waitForInFlight() {
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight.values());
    }
  }

  return { poll, waitForInFlight, get inFlightSize() { return inFlight.size; } };
}
