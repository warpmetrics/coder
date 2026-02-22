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
  const graph = {};

  for (const [key, node] of Object.entries(doc)) {
    if (key === 'states') continue;

    const entry = {
      label: node.label || key,
      executor: node.executor ?? null,
    };
    if (node.parent !== undefined) entry.group = node.parent;
    if (node.results) entry.results = normalizeResults(node.results);

    graph[key] = entry;
  }

  const { ok, errors } = validateGraph(graph, states);
  if (!ok) {
    throw new Error(`Graph validation failed:\n${errors.join('\n')}`);
  }

  return { graph, states };
}
