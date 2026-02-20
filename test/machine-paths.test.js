import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOMES, ACTS } from '../src/names.js';
import {
  GRAPH, ACT_EXECUTOR, RESULT_EDGES, RESULT_OUTCOMES, NEXT_ACT, BOARD_COLUMNS,
} from '../src/machine.js';
import {
  buildTransitionGraph, findReachableActs, validateGraph, findOrphanOutcomes,
} from '../src/machine-graph.js';

// ---------------------------------------------------------------------------
// Graph consistency
// ---------------------------------------------------------------------------

describe('graph consistency', () => {

  it('every outcome name in RESULT_EDGES exists in BOARD_COLUMNS', () => {
    for (const [key, edges] of Object.entries(RESULT_EDGES)) {
      for (const edge of edges) {
        assert.ok(edge.name in BOARD_COLUMNS, `RESULT_EDGES['${key}'] outcome '${edge.name}' missing from BOARD_COLUMNS`);
      }
    }
  });

  it('every non-null NEXT_ACT value is a valid act in GRAPH', () => {
    for (const [key, nextAct] of Object.entries(NEXT_ACT)) {
      if (nextAct === null) continue;
      assert.ok(nextAct in GRAPH, `NEXT_ACT['${key}'] = '${nextAct}' not in GRAPH`);
    }
  });

  it('every act in ACT_EXECUTOR has at least one RESULT_EDGES entry', () => {
    for (const [actName, executorName] of Object.entries(ACT_EXECUTOR)) {
      const hasResult = Object.keys(RESULT_EDGES).some(k => k.startsWith(executorName + ':'));
      assert.ok(hasResult, `ACT_EXECUTOR['${actName}'] = '${executorName}' has no RESULT_EDGES entries`);
    }
  });

  it('RESULT_EDGES and NEXT_ACT have matching keys', () => {
    const reKeys = new Set(Object.keys(RESULT_EDGES));
    const naKeys = new Set(Object.keys(NEXT_ACT));
    for (const key of reKeys) {
      assert.ok(naKeys.has(key), `NEXT_ACT missing key: ${key}`);
    }
    for (const key of naKeys) {
      assert.ok(reKeys.has(key), `RESULT_EDGES missing key: ${key}`);
    }
  });

  it('all acts reachable from BUILD via BFS', () => {
    const reachable = findReachableActs();
    for (const actName of Object.keys(GRAPH)) {
      assert.ok(reachable.has(actName), `${actName} is unreachable from BUILD`);
    }
  });

  it('all work acts reachable from BUILD via BFS', () => {
    const reachable = findReachableActs();
    for (const actName of Object.keys(ACT_EXECUTOR)) {
      assert.ok(reachable.has(actName), `work act ${actName} is unreachable from BUILD`);
    }
  });

  it('RESUMED has no producer (external-only outcome)', () => {
    const orphans = findOrphanOutcomes();
    assert.ok(orphans.includes(OUTCOMES.RESUMED), 'RESUMED should be an orphan outcome');
  });

  it('STARTED has no producer (external-only outcome)', () => {
    const orphans = findOrphanOutcomes();
    assert.ok(orphans.includes(OUTCOMES.STARTED), 'STARTED should be an orphan outcome');
  });

  it('phase group outcomes are not orphans', () => {
    const orphans = findOrphanOutcomes();
    assert.ok(!orphans.includes(OUTCOMES.BUILDING), 'BUILDING should not be orphan');
    assert.ok(!orphans.includes(OUTCOMES.REVIEWING), 'REVIEWING should not be orphan');
    assert.ok(!orphans.includes(OUTCOMES.AWAITING_DEPLOY), 'AWAITING_DEPLOY should not be orphan');
    assert.ok(!orphans.includes(OUTCOMES.RELEASING), 'RELEASING should not be orphan');
  });

  it('validateGraph returns ok', () => {
    const result = validateGraph();
    assert.ok(result.ok, `Graph validation errors: ${result.errors.join(', ')}`);
  });

  it('buildTransitionGraph produces edges for all result types', () => {
    const { edges } = buildTransitionGraph();
    assert.ok(edges.length > 0, 'should have edges');

    // Every RESULT_EDGES key should appear as a via in the transition graph
    for (const key of Object.keys(RESULT_EDGES)) {
      const hasEdge = edges.some(e => e.via === key);
      assert.ok(hasEdge, `no edge for ${key}`);
    }
  });

  it('terminal edges have to=TERMINAL', () => {
    const { edges } = buildTransitionGraph();
    const terminals = edges.filter(e => e.type === 'terminal');
    for (const e of terminals) {
      assert.equal(e.to, 'TERMINAL', `terminal edge ${e.via} should have to=TERMINAL`);
    }
  });

  it('transition edges point to valid acts', () => {
    const { edges } = buildTransitionGraph();
    const transitions = edges.filter(e => e.type === 'transition');
    for (const e of transitions) {
      assert.ok(e.to in GRAPH, `transition edge ${e.via} points to unknown act ${e.to}`);
    }
  });

  it('auto-transition edges come from phase groups', () => {
    const { edges } = buildTransitionGraph();
    const autoEdges = edges.filter(e => e.type === 'auto');
    assert.ok(autoEdges.length === 4, `should have 4 auto-transition edges, got ${autoEdges.length}`);
    for (const e of autoEdges) {
      const node = GRAPH[e.from];
      assert.ok(node, `auto edge from unknown act ${e.from}`);
      assert.equal(node.executor, null, `auto edge ${e.from} should be a phase group`);
    }
  });
});
