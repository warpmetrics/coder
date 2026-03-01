// Runner: orchestrator that picks up pending acts from WarpMetrics,
// runs executors, records outcomes, emits next acts, syncs board.
// All adapters injected via constructor.

import { OUTCOMES, CLASSIFICATIONS } from './graph/names.js';
import { CONCURRENCY, LIMITS } from './defaults.js';
import { normalizeOutcomes } from './graph/index.js';
import { resolveEdges, executeTrigger, availableTriggers } from './graph/ops.js';
import { scanForNewComment, evaluateInterrupt } from './interrupt.js';

// ---------------------------------------------------------------------------
// Recovery: walk back on Issue run outcomes to find last checkpoint.
// Checkpoints are phase-completion outcomes derived from the graph.
// ---------------------------------------------------------------------------

export function findRecoveryTarget(outcomes, checkpoints) {
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const oc = outcomes[i];
    if (!checkpoints.has(oc.name)) continue;
    const act = oc.acts?.[oc.acts.length - 1];
    if (act) return { phase: act.name, opts: act.opts || {} };
  }
  return null;
}

export function createRunner({ warp, board, git, prs, issues, notify, config, claudeCode, graph, states, triggers, checkpoints, execute, effects, contextProviders, log: logFn }) {
  const repoNames = config.repoNames;
  const apiKey = config.warpmetricsApiKey;
  const concurrency = config.concurrency || 1;
  const inFlight = new Map();
  const recoveryAttempts = new Map(); // issueId → { count, lastAttempt }
  const processedComments = new Map(); // issueId → Set<commentId>

  // Derive act → executor mapping from graph at construction time.
  const actExecutor = Object.fromEntries(
    Object.entries(graph).filter(([, n]) => n.executor !== null).map(([a, n]) => [a, n.executor])
  );

  // Derive failure outcome names from classifications for recovery gating.
  const FAILURE_OUTCOMES = new Set(
    CLASSIFICATIONS.filter(c => c.classification === 'failure').map(c => c.name)
  );

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
      log(run.issueId, `[${executorName}] pipeline: run=${p.runId}`);
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
    for (let attempt = 0; attempt < LIMITS.MAX_RETRIES; attempt++) {
      try {
        await warp.recordOutcome(apiKey, { runId: pipelineRunId }, opts);
        return;
      } catch (err) {
        if (attempt < LIMITS.MAX_RETRIES - 1) {
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

      let resolvedFromWait = false;

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

        resolvedFromWait = canWait;

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
          const resolved = resolveEdges(warp, apiKey, edges, run, {
            outcomeOpts: result.outcomeOpts,
            nextActOpts: result.nextActOpts || act.opts,
          });
          nextAct = resolved.nextAct;
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

      // When a waiting act resolves, hand the next act to the work loop
      // instead of chaining inline — avoids blocking the poll for minutes.
      if (resolvedFromWait) {
        run.pendingAct = nextAct;
        break;
      }

      act = nextAct;
    }

    onClearStep?.(run.issueId);
  }

  // -------------------------------------------------------------------------
  // poll — one cycle of intake + processing
  // -------------------------------------------------------------------------

  async function poll({ onStep, onClearStep, onBeforeLog, onPreview } = {}) {
    // Fetch open runs first so intake can dedup.
    let openRuns = [];
    if (apiKey) {
      try {
        openRuns = await warp.findOpenIssueRuns(apiKey, {
          onPartial: (partial) => onPreview?.(partial),
        });
      } catch (err) {
        log(null, `warning: could not fetch open runs: ${err.message}`);
        return { total: 0, processing: 0, inFlight: inFlight.size };
      }
    }

    // Pre-fetch Done/Cancelled sets so intake can skip issues that would be immediately closed.
    let doneIds = new Set();
    let cancelledIds = new Set();
    if (board) {
      const [d, c] = await Promise.allSettled([
        board.scanDone ? board.scanDone() : Promise.resolve(new Set()),
        board.scanCancelled ? board.scanCancelled() : Promise.resolve(new Set()),
      ]);
      if (d.status === 'fulfilled') doneIds = d.value;
      if (c.status === 'fulfilled') cancelledIds = c.value;
    }

    // Intake: discover new issues from board, skip those with existing runs.
    if (board) {
      try {
        const existingIssueIds = new Set(openRuns.map(r => r.issueId));
        const newIssues = await board.scanNewIssues();
        for (const issue of newIssues) {
          if (existingIssueIds.has(issue.issueId)) continue;
          const boardKey = `${issue.repo || repoNames[0]}#${issue.issueId}`;
          if (doneIds.has(boardKey) || cancelledIds.has(boardKey)) continue;
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

    // Cancel: if a run's issue is in the board's Cancelled column, close the run.
    if (apiKey && cancelledIds.size > 0 && triggers?.cancel) {
      for (let i = openRuns.length - 1; i >= 0; i--) {
        const run = openRuns[i];
        if (!run.issueId || !cancelledIds.has(`${run.repo || repoNames[0]}#${run.issueId}`)) continue;
        try {
          await executeTrigger(warp, apiKey, { graph, triggers, states, checkpoints }, run, 'cancel');
          log(run.issueId, `cancelled`);
        } catch (err) {
          log(run.issueId, `warning: cancel failed: ${err.message}`);
        }
        openRuns.splice(i, 1);
      }
    }

    // Done: if a run's issue is manually moved to Done, close the run.
    if (apiKey && doneIds.size > 0 && triggers?.ship) {
      for (let i = openRuns.length - 1; i >= 0; i--) {
        const run = openRuns[i];
        if (!run.issueId || !doneIds.has(`${run.repo || repoNames[0]}#${run.issueId}`)) continue;
        try {
          await executeTrigger(warp, apiKey, { graph, triggers, states, checkpoints }, run, 'ship');
          log(run.issueId, `shipped (moved to Done column)`);
        } catch (err) {
          log(run.issueId, `warning: ship failed: ${err.message}`);
        }
        openRuns.splice(i, 1);
      }
    }

    // Recovery: walk back on Issue run outcomes, find last checkpoint, re-enter.
    if (apiKey && triggers?.reset) {
      const blockedIds = board?.scanBlocked ? await board.scanBlocked() : new Set();

      for (const run of openRuns) {
        if (run.pendingAct) continue;
        if (!run.issueId) continue;
        if (inFlight.has(run.issueId)) continue;

        const target = findRecoveryTarget(run.outcomes, checkpoints);
        if (!target) continue;

        // ── Interrupt: check for new human comment before backoff ──
        const primaryRepo = run.repo || repoNames[0];
        const comment = issues ? await scanForNewComment(issues, run.issueId, primaryRepo, processedComments) : null;

        if (comment && claudeCode) {
          // Mark comment as processed so we don't re-evaluate it.
          if (!processedComments.has(run.issueId)) processedComments.set(run.issueId, new Set());
          processedComments.get(run.issueId).add(comment.id);

          const available = availableTriggers(triggers, run, checkpoints);
          const result = await evaluateInterrupt(claudeCode, comment, run, available, {
            log: (msg) => log(run.issueId, msg),
            onBeforeLog,
          });

          if (result.action !== 'none') {
            // React to comment as acknowledgment.
            try { await issues.addReaction(comment.id, 'eyes', { repo: primaryRepo }); } catch {}

            const trigger = triggers[result.action];
            try {
              const triggerOpts = trigger?.type === 'reset' ? { phase: result.phase } : {};
              const { nextAct } = await executeTrigger(warp, apiKey, { graph, triggers, states, checkpoints }, run, result.action, triggerOpts);

              if (trigger?.type === 'reset') {
                recoveryAttempts.delete(run.issueId);
                run.pendingAct = nextAct;
                if (run.boardItem) {
                  board?.syncState(run.boardItem, states[OUTCOMES.RESUMED] || 'inProgress').catch(() => {});
                }
              }

              log(run.issueId, `interrupt: ${result.action} (comment: "${comment.body.slice(0, 60)}")`);
            } catch (err) {
              log(run.issueId, `warning: interrupt ${result.action} failed: ${err.message}`);
            }
            continue;
          }
        }

        // Known failure + card still in Blocked → wait for human.
        const boardKey = `${primaryRepo}#${run.issueId}`;
        if (FAILURE_OUTCOMES.has(run.latestOutcome) && blockedIds.has(boardKey)) continue;

        // Backoff: skip if too soon since last attempt (60s base, doubles each attempt, max 32min).
        const prev = recoveryAttempts.get(run.issueId);
        const attempt = (prev?.count || 0) + 1;
        if (prev) {
          const delay = Math.min(60_000 * Math.pow(2, prev.count - 1), 60_000 * 32);
          if (Date.now() - prev.lastAttempt < delay) continue;
        }

        recoveryAttempts.set(run.issueId, { count: attempt, lastAttempt: Date.now() });

        try {
          const { nextAct } = await executeTrigger(warp, apiKey, { graph, triggers, states, checkpoints }, run, 'reset');

          run.pendingAct = nextAct;
          log(run.issueId, `recovering → ${target.phase} (attempt ${attempt}, was: ${run.latestOutcome})`);

          if (run.boardItem) {
            board?.syncState(run.boardItem, states[OUTCOMES.RESUMED] || 'inProgress').catch(() => {});
          }
        } catch (err) {
          log(run.issueId, `warning: recovery failed (attempt ${attempt}): ${err.message}`);
        }
      }
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

    const maxWaiting = Math.max(concurrency * CONCURRENCY.WAITING_MULTIPLIER, CONCURRENCY.WAITING_MIN);
    for (const run of waitingActs.slice(0, maxWaiting)) {
      const prevActName = run.pendingAct?.name;
      await processRun(run, { onStep, onClearStep, onBeforeLog });
      // If the waiting act resolved, pendingAct points to the next work act.
      if (run.pendingAct && run.pendingAct.name !== prevActName) {
        workActs.push(run);
      }
    }

    // Launch work acts into available slots.
    const available = concurrency - inFlight.size;
    const toProcess = workActs.slice(0, available);
    const queued = workActs.slice(available);
    for (const run of queued) {
      log(run.issueId, `queued (${inFlight.size}/${concurrency} slots in use)`);
    }

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

    return { total: openRuns.length, processing: toProcess.length, inFlight: inFlight.size, openRuns };
  }

  async function waitForInFlight() {
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight.values());
    }
  }

  function resetRecovery() {
    const count = recoveryAttempts.size;
    recoveryAttempts.clear();
    return count;
  }

  return { poll, waitForInFlight, resetRecovery, get inFlightSize() { return inFlight.size; } };
}
