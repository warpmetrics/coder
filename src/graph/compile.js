// Compiles a parsed YAML document into the { graph, states } shape
// consumed by createRunner() and the derived maps in machine.js.
// Pure function — no I/O.

import { validateGraph } from './validate.js';

function normalizeOutcome(raw) {
  const out = { name: raw.outcome };
  if (raw.on !== undefined) out.in = raw.on;
  if (raw.next !== undefined) out.next = raw.next;
  return out;
}

function normalizeResults(results) {
  const compiled = {};
  for (const [resultType, value] of Object.entries(results)) {
    if (Array.isArray(value)) {
      compiled[resultType] = { outcomes: value.map(normalizeOutcome) };
    } else {
      compiled[resultType] = { outcomes: normalizeOutcome(value) };
    }
  }
  return compiled;
}

export function compileGraph(doc) {
  const states = doc.states || {};
  const triggers = doc.triggers || {};
  const bootstrap = doc.bootstrap || null;
  const graph = {};

  for (const [key, node] of Object.entries(doc)) {
    if (key === 'states' || key === 'triggers' || key === 'bootstrap') continue;

    const entry = {
      label: node.label || key,
      executor: node.executor ?? null,
    };
    if (node.parent !== undefined) entry.group = node.parent;
    if (node.results) entry.results = normalizeResults(node.results);

    graph[key] = entry;
  }

  const { ok, errors } = validateGraph(graph, states, triggers);
  if (!ok) {
    throw new Error(`Graph validation failed:\n${errors.join('\n')}`);
  }

  // Derive checkpoint outcome names from graph structure.
  // A checkpoint is an outcome on the Issue run (in === 'Issue' or no in)
  // whose next act targets a phase group (executor: null).
  const checkpoints = deriveCheckpoints(graph, bootstrap);

  return { graph, states, triggers, checkpoints };
}

function deriveCheckpoints(graph, bootstrap) {
  const phaseGroups = new Set(
    Object.entries(graph).filter(([, n]) => n.executor === null).map(([k]) => k)
  );
  const names = new Set();

  // Bootstrap outcome (e.g. Started → Build).
  if (bootstrap?.outcome && bootstrap?.next && phaseGroups.has(bootstrap.next)) {
    names.add(bootstrap.outcome);
  }

  // Graph outcomes on the Issue run that transition to a phase group.
  for (const node of Object.values(graph)) {
    if (!node.results) continue;
    for (const result of Object.values(node.results)) {
      const outcomes = Array.isArray(result.outcomes) ? result.outcomes : [result.outcomes];
      for (const oc of outcomes) {
        const onIssue = !oc.in || oc.in === 'Issue';
        if (onIssue && oc.next && phaseGroups.has(oc.next)) {
          names.add(oc.name);
        }
      }
    }
  }
  return names;
}
