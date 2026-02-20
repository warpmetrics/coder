#!/usr/bin/env node

// Verifies the state machine graph is internally consistent.
// Exit code 0 = clean, 1 = errors found.

import { GRAPH } from '../src/machine.js';
import { buildTransitionGraph, validateGraph, findReachableActs } from '../src/machine-graph.js';

const { edges } = buildTransitionGraph();
const { ok, errors, warnings } = validateGraph();
const reachable = findReachableActs();

console.log('State Machine Verification');
console.log('===========================');
console.log(`Acts: ${Object.keys(GRAPH).length}`);
console.log(`Edges: ${edges.length}`);
console.log(`Reachable from BUILD: ${reachable.size} / ${Object.keys(GRAPH).length}`);
console.log('');

console.log('Graph Consistency:');
if (errors.length === 0) {
  console.log('  [PASS] All nodes have label, executor, results');
  console.log('  [PASS] All next acts valid');
  console.log('  [PASS] All outcomes in BOARD_COLUMNS');
  console.log('  [PASS] All acts reachable from BUILD');
} else {
  for (const err of errors) {
    console.log(`  [FAIL] ${err}`);
  }
}

for (const warn of warnings) {
  console.log(`  [WARN] ${warn}`);
}

console.log('');

// Transition table.
console.log('Transition Table:');
for (const edge of edges) {
  console.log(`  ${edge.from} ──${edge.via}──> ${edge.to}`);
}

console.log('');

if (!ok) {
  console.log(`FAILED: ${errors.length} error(s) found`);
  process.exit(1);
} else {
  console.log('OK');
}
