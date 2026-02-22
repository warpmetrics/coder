// Runner: orchestrator that picks up pending acts from WarpMetrics,
// runs executors, records outcomes, emits next acts, syncs board.
// All adapters injected via constructor.

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

export function createRunner({ warp, board, git, prs, issues, notify, config, claudeCode, graph, states, execute, effects, contextProviders, log: logFn }) {
  const repoNames = config.repoNames;
  const apiKey = config.warpmetricsApiKey;
  const concurrency = config.concurrency || 1;
  const inFlight = new Map();

  // Derive act → executor mapping from graph at construction time.
  const actExecutor = Object.fromEntries(
    Object.entries(graph).filter(([, n]) => n.executor !== null).map(([a, n]) => [a, n.executor])
  );

  // Derive outcome → retry target for terminal results (none of the edges have `next`).
  // Maps outcome name → { actName, groupLabel, boardState } for retry-from-blocked.
  const retryTargets = {};
  for (const [actName, node] of Object.entries(graph)) {
    if (node.executor === null) continue;
    const groupLabel = node.group ? (graph[node.group]?.label || node.group) : null;

    // Look up the phase group's "created" outcome to determine the correct board state.
    let boardState = states[OUTCOMES.RESUMED]; // fallback: inProgress
    if (node.group) {
      const groupNode = graph[node.group];
      if (groupNode?.results?.created) {
        const createdEdges = normalizeOutcomes(groupNode.results.created.outcomes);
        const createdOutcome = createdEdges[createdEdges.length - 1]?.name;
        if (createdOutcome && states[createdOutcome]) boardState = states[createdOutcome];
      }
    }

    for (const resultDef of Object.values(node.results)) {
      const edges = normalizeOutcomes(resultDef.outcomes);
      const hasNext = edges.some(e => e.next);
      if (hasNext) continue;
      // All edges for this result are terminal — use the last edge's outcome name.
      const outcomeName = edges[edges.length - 1].name;
      if (outcomeName) {
        retryTargets[outcomeName] = { actName, groupLabel, boardState };
      }
    }
  }

  // Derive allowed result types per executor from graph (for runtime enforcement).
  const executorResultTypes = new Map();
  for (const node of Object.values(graph)) {
    if (node.executor === null) continue;
    if (!executorResultTypes.has(node.executor)) {
      executorResultTypes.set(node.executor, new Set());
    }
    for (const resultType of Object.keys(node.results)) {
      executorResultTypes.get(node.executor).add(resultType);
    }
  }

  function log(issueId, msg) {
    logFn?.(issueId, msg);
  }

  // -------------------------------------------------------------------------
  // Pipeline telemetry helpers.
  // -------------------------------------------------------------------------

  async function startPipeline(executorName, run, act) {
    if (!apiKey) return null;
    try {
      const pNode = graph[act.name];
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
    const opts = {
      step: executorName, success: result.type !== 'error',
      costUsd: result.costUsd, error: result.type === 'error' ? result.error : undefined,
      ...result.outcomeOpts,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await warp.recordOutcome(apiKey, { runId: pipelineRunId }, opts);
        return;
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        } else {
          log(run.issueId, `warning: outcome recording failed: ${err.message}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // processRun — the core act-driven step
  // -------------------------------------------------------------------------

  async function processRun(run, { onStep, onClearStep, onBeforeLog } = {}) {
    let act = run.pendingAct;
    if (!act) return;

    const visited = new Set();
    while (act) {
      if (visited.has(act.name)) break;
      visited.add(act.name);

      const node = graph[act.name];
      if (!node) break;

      // ── Step 1: Produce result ──────────────────────────────────
      let result;
      let executorName = node.executor;

      if (executorName === null) {
        // Phase group: create group, auto-resolve to 'created'.
        if (apiKey) {
          const { groupId } = warp.batchGroup(apiKey, { runId: run.id, label: node.label });
          if (!run.groups) run.groups = new Map();
          run.groups.set(node.label, groupId);
        }
        result = { type: 'created' };
        log(run.issueId, `phase: ${node.label}`);
      } else {
        if (!execute[executorName]) break;
        onStep?.(run.issueId, node.label || executorName);

        const canWait = Object.keys(node.results).includes('waiting');

        // Run context provider if one exists for this executor.
        let extraContext = {};
        const provider = contextProviders?.[executorName];
        if (provider) {
          try { Object.assign(extraContext, await provider(run, act)); }
          catch (err) { log(run.issueId, `warning: context provider failed: ${err.message}`); }
        }

        // Before effect (awaited — effect decides whether to block by awaiting its own work or returning immediately).
        const beforeKey = `${executorName}:before`;
        if (effects[beforeKey]) {
          try {
            await effects[beforeKey](run, {
              config,
              clients: { git, prs, issues, notify, warp, board, log: (msg) => log(run.issueId, `[${executorName}] ${msg}`) },
              context: { actOpts: act.opts, ...extraContext },
            });
          } catch (err) {
            log(run.issueId, `warning: before effect failed: ${err.message}`);
          }
        }

        // Pipeline (skip for waiting-capable executors until they resolve).
        let pipelineRunId = canWait ? null : await startPipeline(executorName, run, act);

        // Execute.
        const executorLog = (msg) => log(run.issueId, `[${executorName}] ${msg}`);
        result = await execute[executorName](run, {
          config,
          clients: { git, prs, issues, notify, claudeCode: claudeCode?.forRun(pipelineRunId), warp, log: executorLog },
          context: { pipelineRunId, actOpts: act.opts, onStep: (step) => onStep?.(run.issueId, step), onBeforeLog, ...extraContext },
        });

        // Enforce: result type must be declared in graph.
        const allowed = executorResultTypes.get(executorName);
        if (allowed && !allowed.has(result.type)) {
          log(run.issueId, `error: executor '${executorName}' returned undeclared result type '${result.type}' (expected: ${[...allowed].join(', ')})`);
          break;
        }

        if (result.type === 'waiting') break;

        // Create pipeline retroactively for waiting-capable executors that resolved.
        if (!pipelineRunId) pipelineRunId = await startPipeline(executorName, run, act);
        await finishPipeline(pipelineRunId, executorName, run, result);
      }

      // ── Step 2: Resolve edges from graph ──────────────────────────
      const resultDef = node.results[result.type];
      if (!resultDef) break;
      const edges = normalizeOutcomes(resultDef.outcomes);

      // ── Step 3: Atomic commit (outcomes + act in single flush) ──
      let nextAct = null;
      if (apiKey) {
        try {
          let recordedOnIssueRun = false;
          for (const edge of edges) {
            const containerId = resolveContainer(edge.in, run, log);
            if (containerId === run.id) recordedOnIssueRun = true;

            const { outcomeId } = warp.batchOutcome(apiKey, {
              runId: containerId, name: edge.name, opts: result.outcomeOpts,
            });

            if (edge.next) {
              if (!outcomeId) {
                log(run.issueId, `warning: outcomeId missing for ${edge.name}, cannot emit ${edge.next}`);
              } else {
                const nao = result.nextActOpts || act.opts || {};
                const { actId } = warp.batchAct(apiKey, {
                  outcomeId, name: edge.next, opts: nao,
                });
                nextAct = { id: actId, name: edge.next, opts: nao };
              }
            }
          }

          // Mirror last outcome on Issue Run for board tracking.
          if (!recordedOnIssueRun) {
            warp.batchOutcome(apiKey, { runId: run.id, name: edges[edges.length - 1].name });
          }

          await warp.batchFlush(apiKey);
        } catch (err) {
          log(run.issueId, `warning: outcome/act failed: ${err.message}`);
          break;
        }
      }

      // ── Step 4: Board sync (one place, fire-and-forget) ─────────
      const boardOutcomeName = edges[edges.length - 1].name;
      if (board && run.boardItem) {
        const column = states[boardOutcomeName];
        if (column) {
          board.syncState(run.boardItem, column).catch(err =>
            log(run.issueId, `warning: board sync to ${column} failed: ${err.message}`)
          );
        }
      }

      // ── Step 5: Effects ─────────────────────────────────────────
      const resultKey = executorName ? `${executorName}:${result.type}` : `${act.name}:${result.type}`;
      if (effects[resultKey]) {
        try {
          await effects[resultKey](run, result, {
              config,
              clients: { git, prs, issues, notify, warp, board, log: (msg) => log(run.issueId, `[${executorName || act.name}] ${msg}`) },
            });
        } catch (err) {
          log(run.issueId, `warning: effect failed: ${err.message}`);
        }
      }

      // ── Step 6: Continue or break ──────────────────────────────
      run.latestOutcome = boardOutcomeName;
      if (!nextAct) break;
      act = nextAct;
    }

    onClearStep?.(run.issueId);
  }

  // -------------------------------------------------------------------------
  // poll — one cycle of intake + processing
  // -------------------------------------------------------------------------

  async function poll({ onStep, onClearStep, onBeforeLog } = {}) {
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
      } catch (err) { log(null, `warning: board item fetch failed: ${err.message}`); }
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
      } catch (err) { log(null, `warning: scan aborted failed: ${err.message}`); }
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
              await warp.recordIssueOutcome(apiKey, { runId: run.id, name: OUTCOMES.MANUAL_RELEASE });
              log(run.issueId, `shipped (moved to Done column)`);
            } catch (err) {
              log(run.issueId, `warning: ship failed: ${err.message}`);
            }
            openRuns.splice(i, 1);
          }
        }
      } catch (err) { log(null, `warning: scan done failed: ${err.message}`); }
    }

    // Retry: re-emit last act when card leaves Blocked column.
    if (board?.scanBlocked && apiKey) {
      try {
        const blockedIds = await board.scanBlocked();
        const retriedIds = new Set();
        for (const run of openRuns) {
          if (run.pendingAct) continue;
          if (!run.issueId) continue;
          if (inFlight.has(run.issueId)) continue;
          if (retriedIds.has(run.issueId)) continue;
          if (blockedIds.has(run.issueId)) continue;

          // Derive retry target from graph using the run's latest outcome.
          const target = retryTargets[run.latestOutcome];
          if (!target) continue;

          const parentId = target.groupLabel ? run.groups?.get(target.groupLabel) : run.id;
          if (!parentId) continue;

          try {
            const { outcomeId } = warp.batchOutcome(apiKey, {
              runId: parentId, name: OUTCOMES.RESUMED,
            });
            const { actId } = warp.batchAct(apiKey, {
              outcomeId, name: target.actName, opts: {},
            });
            await warp.batchFlush(apiKey);

            run.pendingAct = { id: actId, name: target.actName, opts: {} };
            retriedIds.add(run.issueId);
            log(run.issueId, `retrying ${target.actName} (unblocked)`);

            if (run.boardItem && target.boardState) {
              board.syncState(run.boardItem, target.boardState).catch(err =>
                log(run.issueId, `warning: board sync failed: ${err.message}`)
              );
            }
          } catch (err) {
            log(run.issueId, `warning: retry failed: ${err.message}`);
          }
        }
      } catch (err) { log(null, `warning: scan blocked failed: ${err.message}`); }
    }

    // Process waiting-capable acts first (await_deploy, await_reply) — they
    // resolve instantly and should not consume concurrency slots.
    const ready = openRuns.filter(r => r.issueId && !inFlight.has(r.issueId) && r.pendingAct);
    const waitingActs = [];
    const workActs = [];
    for (const run of ready) {
      const node = graph[run.pendingAct.name];
      const executorName = actExecutor[run.pendingAct.name];
      const isWaiting = node && executorName && Object.keys(node.results).includes('waiting');
      (isWaiting ? waitingActs : workActs).push(run);
    }

    const maxWaiting = Math.max(concurrency * 5, 10);
    for (const run of waitingActs.slice(0, maxWaiting)) {
      await processRun(run, { onStep, onClearStep, onBeforeLog });
    }

    // Launch work acts into available slots.
    const available = concurrency - inFlight.size;
    const toProcess = workActs.slice(0, available);

    for (const run of toProcess) {
      onStep?.(run.issueId, run.pendingAct.name);
      const promise = processRun(run, { onStep, onClearStep, onBeforeLog })
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
