// Pure state machine for issue lifecycle.
// Zero I/O — every mapping is testable data.
//
// GRAPH is the single source of truth. All other exports are derived from it.
// Loaded from graphs/issue.yaml via the YAML compiler.

import { loadGraph } from './graph/index.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const { graph: GRAPH, states: STATES } = loadGraph(join(__dirname, '../graphs/issue.yaml'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

// ---------------------------------------------------------------------------
// Derived maps — all computed from GRAPH.
// Phase groups (executor === null) are excluded from executor-keyed maps.
// ---------------------------------------------------------------------------

// Act name → executor function name (only work acts).
export const ACT_EXECUTOR = Object.fromEntries(
  Object.entries(GRAPH)
    .filter(([, node]) => node.executor !== null)
    .map(([act, node]) => [act, node.executor])
);

// Act name → parent group label (from node.group, only work acts).
export const ACT_GROUP = Object.fromEntries(
  Object.entries(GRAPH)
    .filter(([, node]) => node.executor !== null && node.group)
    .map(([act, node]) => [act, node.group])
);

// executor:resultType → normalized outcomes array [{ name, in?, next? }].
export const RESULT_EDGES = {};

// executor:resultType → last outcome name (for board column lookup).
export const RESULT_OUTCOMES = {};

// executor:resultType → next act name (from whichever outcome has it, or null).
export const NEXT_ACT = {};

for (const node of Object.values(GRAPH)) {
  if (node.executor === null) continue;
  for (const [resultType, result] of Object.entries(node.results)) {
    const key = `${node.executor}:${resultType}`;
    const edges = normalizeOutcomes(result.outcomes);
    RESULT_EDGES[key] = edges;
    RESULT_OUTCOMES[key] = edges[edges.length - 1].name;
    NEXT_ACT[key] = edges.find(e => e.next)?.next || null;
  }
}
