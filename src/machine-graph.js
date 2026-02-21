// Derives the complete transition graph from GRAPH in machine.js.
// Pure functions — no I/O, fully testable.
// All functions accept optional graph/states params, defaulting to built-in.

import {
  GRAPH as DEFAULT_GRAPH, STATES as DEFAULT_STATES,
} from './machine.js';
import { ACTS } from './names.js';

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

// Derive maps from a given graph (same logic as machine.js but local).
function deriveMaps(graph) {
  const actExecutor = {};
  const resultEdges = {};
  const resultOutcomes = {};
  const nextAct = {};

  for (const [actName, node] of Object.entries(graph)) {
    if (node.executor === null) continue;
    actExecutor[actName] = node.executor;
    for (const [resultType, result] of Object.entries(node.results)) {
      const key = `${node.executor}:${resultType}`;
      const edges = normalizeOutcomes(result.outcomes);
      resultEdges[key] = edges;
      resultOutcomes[key] = edges[edges.length - 1].name;
      nextAct[key] = edges.find(e => e.next)?.next || null;
    }
  }

  return { actExecutor, resultEdges, resultOutcomes, nextAct };
}

/**
 * Build all transition edges from the graph.
 * Returns { edges }.
 *
 * edges: [{ from, via, to, outcome, inLabel, type }]
 *   from/to: act names (or 'TERMINAL' for null next-act)
 *   via: 'actName:resultType' for phase groups, 'executor:resultType' for work acts
 *   type: 'transition' | 'terminal' | 'auto'
 */
export function buildTransitionGraph(graph = DEFAULT_GRAPH) {
  const edges = [];

  for (const [actName, node] of Object.entries(graph)) {
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
export function findReachableActs(startAct = ACTS.BUILD, graph = DEFAULT_GRAPH) {
  const { edges } = buildTransitionGraph(graph);
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
export function validateGraph(graph = DEFAULT_GRAPH, states = DEFAULT_STATES) {
  const errors = [];
  const warnings = [];

  const { actExecutor, resultEdges, nextAct } = deriveMaps(graph);

  const graphLabels = new Set(Object.values(graph).map(n => n.label));

  // Every graph node has label, executor (or null for phases), results.
  for (const [act, node] of Object.entries(graph)) {
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

  // Every result has outcomes with valid shape. Every 'in' is 'Issue' or matches a graph label.
  for (const [act, node] of Object.entries(graph)) {
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

  // Every act in actExecutor should have at least one resultEdges entry.
  for (const [actName, executorName] of Object.entries(actExecutor)) {
    const hasResult = Object.keys(resultEdges).some(k => k.startsWith(executorName + ':'));
    if (!hasResult) {
      errors.push(`ACT_EXECUTOR['${actName}'] = '${executorName}' has no RESULT_EDGES entries`);
    }
  }

  // Every resultEdges entry should have a matching nextAct entry.
  for (const key of Object.keys(resultEdges)) {
    if (!(key in nextAct)) {
      errors.push(`RESULT_EDGES['${key}'] has no NEXT_ACT entry`);
    }
  }

  // Every non-null nextAct value should be a valid act in graph.
  for (const [key, next] of Object.entries(nextAct)) {
    if (next !== null && !(next in graph)) {
      errors.push(`NEXT_ACT['${key}'] = '${next}' not in GRAPH`);
    }
  }

  // Every outcome name in resultEdges should have a states entry.
  for (const [key, edges] of Object.entries(resultEdges)) {
    for (const edge of edges) {
      if (!(edge.name in states)) {
        errors.push(`RESULT_EDGES['${key}'] outcome '${edge.name}' not in STATES`);
      }
    }
  }

  // All acts reachable from first act in graph.
  const firstAct = Object.keys(graph)[0];
  if (firstAct) {
    const reachable = findReachableActs(firstAct, graph);
    for (const actName of Object.keys(graph)) {
      if (!reachable.has(actName)) {
        warnings.push(`Act '${actName}' is unreachable from ${firstAct}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Find outcomes in states that no resultEdges entry produces
 * and no phase group produces.
 * These are external-only outcomes (e.g. RESUMED, STARTED, ABORTED).
 */
export function findOrphanOutcomes(graph = DEFAULT_GRAPH, states = DEFAULT_STATES) {
  const produced = new Set();

  // Work act outcomes.
  const { resultEdges } = deriveMaps(graph);
  for (const edges of Object.values(resultEdges)) {
    for (const edge of edges) {
      produced.add(edge.name);
    }
  }

  // Phase group outcomes.
  for (const node of Object.values(graph)) {
    if (node.executor === null) {
      for (const result of Object.values(node.results)) {
        const outcomes = normalizeOutcomes(result.outcomes);
        for (const oc of outcomes) produced.add(oc.name);
      }
    }
  }

  const orphans = [];
  for (const outcome of Object.keys(states)) {
    if (!produced.has(outcome)) orphans.push(outcome);
  }
  return orphans;
}
