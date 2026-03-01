// Pure function: graph → phase pipeline layout data.
// No I/O, no React — just data transformation.

/**
 * Extract phases (nodes with executor: null) and their child acts from a graph.
 * Returns [{ name, label, acts: [{ name, label }] }] in graph order.
 */
export function extractPhases(graph) {
  const phases = [];
  const phaseMap = new Map();

  for (const [name, node] of Object.entries(graph)) {
    if (node.executor === null) {
      const phase = { name, label: node.label || name, acts: [] };
      phases.push(phase);
      phaseMap.set(name, phase);
    }
  }

  for (const [name, node] of Object.entries(graph)) {
    if (node.executor !== null && node.group) {
      const phase = phaseMap.get(node.group);
      if (phase) {
        phase.acts.push({ name, label: node.label || name });
      }
    }
  }

  return phases;
}

/**
 * Determine which phase and act are currently active for a run.
 * Returns { activePhase, activeAct, completedPhases }
 */
export function resolvePosition(phases, run) {
  let activeAct = run.pendingAct?.name || null;
  let activePhase = null;
  const completedPhases = new Set();

  // Find which phase contains the active act.
  for (const phase of phases) {
    for (const act of phase.acts) {
      if (act.name === activeAct) {
        activePhase = phase.name;
      }
    }
  }

  // If pendingAct is a phase itself (group node), resolve to first child act.
  if (!activePhase && activeAct) {
    for (const phase of phases) {
      if (phase.name === activeAct) {
        activePhase = phase.name;
        if (phase.acts.length > 0) {
          activeAct = phase.acts[0].name;
        }
        break;
      }
    }
  }

  // Mark phases before the active one as completed.
  if (activePhase) {
    for (const phase of phases) {
      if (phase.name === activePhase) break;
      completedPhases.add(phase.name);
    }
  }

  return { activePhase, activeAct, completedPhases };
}

/**
 * Classify an outcome name for color coding.
 * Returns 'success' | 'failure' | 'waiting' | 'neutral'
 */
export function classifyOutcome(outcomeName) {
  if (!outcomeName) return 'neutral';
  const failures = new Set([
    'Implementation Failed', 'Revision Failed', 'Merge Failed',
    'Deploy Failed', 'Release Failed', 'Review Failed', 'Max Retries',
    'Cancelled', 'Interrupted',
  ]);
  const successes = new Set([
    'PR Created', 'Fixes Applied', 'Merged', 'Deployed', 'Released',
    'Approved', 'Clarified', 'Manual Release', 'Deploy Approved',
  ]);
  const waiting = new Set([
    'Waiting', 'Awaiting Deploy', 'Needs Clarification',
    'Changes Requested',
  ]);
  if (failures.has(outcomeName)) return 'failure';
  if (successes.has(outcomeName)) return 'success';
  if (waiting.has(outcomeName)) return 'waiting';
  return 'neutral';
}

/**
 * Extract display title from a run object.
 * Strips "Issue #N: " prefix, falls back to pendingAct title.
 */
export function runTitle(run) {
  let title = run.title || run.pendingAct?.opts?.title || '';
  title = title.replace(/^Issue #\d+:\s*/, '');
  return title;
}

/**
 * Get the step label for a run (the current executor step name).
 */
export function stepLabel(steps, issueId) {
  const s = steps.get(issueId);
  return s ? s.step : null;
}

/**
 * Format elapsed time in compact human form.
 */
export function formatElapsed(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${String(remM).padStart(2, '0')}m`;
}
