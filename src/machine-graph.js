// Derives the complete transition graph from GRAPH in machine.js.
// Pure functions — no I/O, fully testable.

import {
  GRAPH, ACT_EXECUTOR, RESULT_EDGES, RESULT_OUTCOMES, NEXT_ACT, BOARD_COLUMNS,
} from './machine.js';
import { ACTS } from './names.js';

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

/**
 * Build all transition edges from the GRAPH.
 * Returns { edges }.
 *
 * edges: [{ from, via, to, outcome, inLabel, type }]
 *   from/to: act names (or 'TERMINAL' for null next-act)
 *   via: 'actName:resultType' for phase groups, 'executor:resultType' for work acts
 *   type: 'transition' | 'terminal' | 'auto'
 */
export function buildTransitionGraph() {
  const edges = [];

  for (const [actName, node] of Object.entries(GRAPH)) {
    for (const [resultType, result] of Object.entries(node.results)) {
      const via = node.executor
        ? `${node.executor}:${resultType}`
        : `${actName}:${resultType}`;

      const outcomes = normalizeOutcomes(result.outcomes);
      const withNext = outcomes.find(e => e.next);
      const lastOutcome = outcomes[outcomes.length - 1];

      edges.push({
        from: actName,
        via,
        to: withNext?.next || 'TERMINAL',
        outcome: lastOutcome.name,
        inLabel: withNext?.in || lastOutcome.in || null,
        type: withNext?.next
          ? (node.executor === null ? 'auto' : 'transition')
          : 'terminal',
      });
    }
  }

  return { edges };
}

/**
 * BFS from a start act to find all reachable acts.
 */
export function findReachableActs(startAct = ACTS.BUILD) {
  const { edges } = buildTransitionGraph();
  const visited = new Set([startAct]);
  const queue = [startAct];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of edges) {
      if (edge.from === current && edge.to !== 'TERMINAL' && !visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  return visited;
}

/**
 * Validate that the graph is internally consistent.
 * Returns { ok, errors, warnings }.
 */
export function validateGraph() {
  const errors = [];
  const warnings = [];

  const graphLabels = new Set(Object.values(GRAPH).map(n => n.label));

  // Every GRAPH node has label, executor (or null for phases), results.
  for (const [act, node] of Object.entries(GRAPH)) {
    if (typeof node.label !== 'string' || !node.label) {
      errors.push(`GRAPH['${act}'] missing label`);
    }
    if (node.executor !== null && typeof node.executor !== 'string') {
      errors.push(`GRAPH['${act}'] executor must be a string or null`);
    }
    if (!node.results || Object.keys(node.results).length === 0) {
      errors.push(`GRAPH['${act}'] missing results`);
    }

    // Phase groups must have executor: null and a single 'created' result.
    if (node.executor === null) {
      const resultKeys = Object.keys(node.results);
      if (resultKeys.length !== 1 || resultKeys[0] !== 'created') {
        errors.push(`GRAPH['${act}'] is a phase group but does not have exactly one 'created' result`);
      }
    }
  }

  // Every result has outcomes with valid shape. Every 'in' is 'Issue' or matches a GRAPH label.
  for (const [act, node] of Object.entries(GRAPH)) {
    for (const [resultType, result] of Object.entries(node.results)) {
      if (!result.outcomes) {
        errors.push(`GRAPH['${act}'].results.${resultType} missing outcomes`);
        continue;
      }
      const outcomes = normalizeOutcomes(result.outcomes);
      for (let i = 0; i < outcomes.length; i++) {
        const oc = outcomes[i];
        if (typeof oc.name !== 'string') {
          errors.push(`GRAPH['${act}'].results.${resultType}.outcomes[${i}] missing name`);
        }
        if (oc.next !== undefined && typeof oc.next !== 'string') {
          errors.push(`GRAPH['${act}'].results.${resultType}.outcomes[${i}] invalid next`);
        }
        if (oc.in !== undefined) {
          if (oc.in !== 'Issue' && !graphLabels.has(oc.in)) {
            errors.push(`GRAPH['${act}'].results.${resultType}.outcomes[${i}] 'in' value '${oc.in}' is not 'Issue' and does not match any GRAPH label`);
          }
        }
      }
    }
  }

  // Every act in ACT_EXECUTOR should have at least one RESULT_EDGES entry.
  for (const [actName, executorName] of Object.entries(ACT_EXECUTOR)) {
    const hasResult = Object.keys(RESULT_EDGES).some(k => k.startsWith(executorName + ':'));
    if (!hasResult) {
      errors.push(`ACT_EXECUTOR['${actName}'] = '${executorName}' has no RESULT_EDGES entries`);
    }
  }

  // Every RESULT_EDGES entry should have a matching NEXT_ACT entry.
  for (const key of Object.keys(RESULT_EDGES)) {
    if (!(key in NEXT_ACT)) {
      errors.push(`RESULT_EDGES['${key}'] has no NEXT_ACT entry`);
    }
  }

  // Every non-null NEXT_ACT value should be a valid act in GRAPH.
  for (const [key, nextAct] of Object.entries(NEXT_ACT)) {
    if (nextAct !== null && !(nextAct in GRAPH)) {
      errors.push(`NEXT_ACT['${key}'] = '${nextAct}' not in GRAPH`);
    }
  }

  // Every outcome name in RESULT_EDGES should have a BOARD_COLUMNS entry.
  for (const [key, edges] of Object.entries(RESULT_EDGES)) {
    for (const edge of edges) {
      if (!(edge.name in BOARD_COLUMNS)) {
        errors.push(`RESULT_EDGES['${key}'] outcome '${edge.name}' not in BOARD_COLUMNS`);
      }
    }
  }

  // All acts reachable from BUILD.
  const reachable = findReachableActs();
  for (const actName of Object.keys(GRAPH)) {
    if (!reachable.has(actName)) {
      warnings.push(`Act '${actName}' is unreachable from BUILD`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Find outcomes in BOARD_COLUMNS that no RESULT_EDGES entry produces
 * and no phase group produces.
 * These are external-only outcomes (e.g. RESUMED, STARTED, ABORTED).
 */
export function findOrphanOutcomes() {
  const produced = new Set();

  // Work act outcomes.
  for (const edges of Object.values(RESULT_EDGES)) {
    for (const edge of edges) {
      produced.add(edge.name);
    }
  }

  // Phase group outcomes.
  for (const node of Object.values(GRAPH)) {
    if (node.executor === null) {
      for (const result of Object.values(node.results)) {
        const outcomes = normalizeOutcomes(result.outcomes);
        for (const oc of outcomes) produced.add(oc.name);
      }
    }
  }

  const orphans = [];
  for (const outcome of Object.keys(BOARD_COLUMNS)) {
    if (!produced.has(outcome)) orphans.push(outcome);
  }
  return orphans;
}
