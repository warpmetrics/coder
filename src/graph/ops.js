// Graph operations: trigger evaluation and edge resolution.
// Pure logic — all I/O (warp, board) injected via arguments.

import { normalizeOutcomes } from './index.js';
import { OUTCOMES } from './names.js';
import { findRecoveryTarget } from '../runner.js';

// ---------------------------------------------------------------------------
// resolveContainer — maps an 'in' label to a container ID.
// ---------------------------------------------------------------------------

function resolveContainer(inLabel, run) {
  if (!inLabel || inLabel === 'Issue') return run.id;
  const groupId = run.groups?.get(inLabel);
  return groupId || run.id;
}

// ---------------------------------------------------------------------------
// resolveEdges — emit outcomes + next act from a result's edges.
//
// Extracted from runner.js processRun steps 2-3. Shared by both the runner
// and executeTrigger. Walks edges, emits outcomes on the right containers,
// emits next act if present, mirrors on Issue Run for board tracking.
//
// Returns { nextAct, boardOutcomeName } or null on failure.
// ---------------------------------------------------------------------------

export function resolveEdges(warp, apiKey, edges, run, { outcomeOpts, nextActOpts } = {}) {
  let nextAct = null;
  let recordedOnIssueRun = false;

  for (const edge of edges) {
    const containerId = resolveContainer(edge.in, run);
    if (containerId === run.id) recordedOnIssueRun = true;

    const { outcomeId } = warp.batchOutcome(apiKey, {
      runId: containerId, name: edge.name, opts: outcomeOpts,
    });

    if (edge.next) {
      if (!outcomeId) {
        console.warn(`resolveEdges: batchOutcome returned null id for '${edge.name}', skipping next act '${edge.next}'`);
        continue;
      }
      const nao = nextActOpts || {};
      const { actId } = warp.batchAct(apiKey, {
        outcomeId, name: edge.next, opts: nao,
      });
      nextAct = { id: actId, name: edge.next, opts: nao };
    }
  }

  // Mirror last outcome on Issue Run for board tracking.
  if (!recordedOnIssueRun) {
    warp.batchOutcome(apiKey, { runId: run.id, name: edges[edges.length - 1].name });
  }

  const boardOutcomeName = edges[edges.length - 1].name;
  return { nextAct, boardOutcomeName };
}

// ---------------------------------------------------------------------------
// availableTriggers — which triggers a UI can show right now.
// ---------------------------------------------------------------------------

export function availableTriggers(triggers, run, checkpoints) {
  const available = [];

  for (const [name, trigger] of Object.entries(triggers)) {
    switch (trigger.type) {
      case 'act':
        if (run.pendingAct?.name === trigger.act) {
          available.push({ name, ...trigger });
        }
        break;
      case 'global':
        available.push({ name, ...trigger });
        break;
      case 'reset':
        if (!run.pendingAct) {
          const target = findRecoveryTarget(run.outcomes || [], checkpoints);
          if (target) available.push({ name, ...trigger });
        }
        break;
    }
  }

  return available;
}

// ---------------------------------------------------------------------------
// executeTrigger — run a named trigger against a run.
//
// Returns { boardOutcomeName, nextAct } for act triggers,
// { boardOutcomeName } for global/reset.
// ---------------------------------------------------------------------------

export async function executeTrigger(warp, apiKey, { graph, triggers, states, checkpoints }, run, triggerName, opts = {}) {
  const trigger = triggers[triggerName];
  if (!trigger) throw new Error(`Unknown trigger: ${triggerName}`);

  switch (trigger.type) {
    case 'act': {
      const node = graph[trigger.act];
      if (!node) throw new Error(`Trigger '${triggerName}' references unknown act '${trigger.act}'`);
      const resultDef = node.results[trigger.result];
      if (!resultDef) throw new Error(`Trigger '${triggerName}' references unknown result '${trigger.result}' on '${trigger.act}'`);

      const edges = normalizeOutcomes(resultDef.outcomes);
      const result = resolveEdges(warp, apiKey, edges, run, {
        outcomeOpts: opts.outcomeOpts,
        nextActOpts: opts.nextActOpts || run.pendingAct?.opts,
      });
      await warp.batchFlush(apiKey);
      return result;
    }

    case 'global': {
      warp.batchOutcome(apiKey, { runId: run.id, name: trigger.outcome });
      await warp.batchFlush(apiKey);
      return { boardOutcomeName: trigger.outcome, nextAct: null };
    }

    case 'reset': {
      const target = opts.phase
        ? findCheckpointForPhase(run.outcomes || [], opts.phase, checkpoints)
        : findRecoveryTarget(run.outcomes || [], checkpoints);

      if (!target) throw new Error('No recovery target found');

      const stuckGroupId = run.groups?.get(target.phase);
      if (stuckGroupId) {
        warp.batchOutcome(apiKey, { runId: stuckGroupId, name: OUTCOMES.INTERRUPTED });
      }

      const { outcomeId } = warp.batchOutcome(apiKey, { runId: run.id, name: OUTCOMES.RESUMED });
      warp.batchAct(apiKey, { outcomeId, name: target.phase, opts: target.opts });
      await warp.batchFlush(apiKey);

      return {
        boardOutcomeName: OUTCOMES.RESUMED,
        nextAct: { name: target.phase, opts: target.opts },
      };
    }

    default:
      throw new Error(`Unknown trigger type: ${trigger.type}`);
  }
}

// ---------------------------------------------------------------------------
// findCheckpointForPhase — find a specific checkpoint by phase name.
// Used by reset trigger with phase override.
// ---------------------------------------------------------------------------

function findCheckpointForPhase(outcomes, phase, checkpoints) {
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const oc = outcomes[i];
    if (!checkpoints.has(oc.name)) continue;
    const act = oc.acts?.[oc.acts.length - 1];
    if (act?.name === phase) return { phase: act.name, opts: act.opts || {} };
  }
  return null;
}
