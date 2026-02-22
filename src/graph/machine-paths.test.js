import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOMES, ACTS } from './names.js';
import { GRAPH, STATES } from './machine.js';
import {
  normalizeOutcomes, buildTransitionGraph, findReachableActs, validateGraph, findOrphanOutcomes,
} from './index.js';

// Derive maps from GRAPH (mirrors what runner.js does at runtime).
const ACT_EXECUTOR = Object.fromEntries(
  Object.entries(GRAPH).filter(([, n]) => n.executor !== null).map(([a, n]) => [a, n.executor])
);
const RESULT_EDGES = {};
const NEXT_ACT = {};
for (const node of Object.values(GRAPH)) {
  if (node.executor === null) continue;
  for (const [resultType, result] of Object.entries(node.results)) {
    const key = `${node.executor}:${resultType}`;
    const edges = normalizeOutcomes(result.outcomes);
    RESULT_EDGES[key] = edges;
    NEXT_ACT[key] = edges.find(e => e.next)?.next || null;
  }
}

// ---------------------------------------------------------------------------
// Graph consistency
// ---------------------------------------------------------------------------

describe('graph consistency', () => {

  it('every outcome name in RESULT_EDGES exists in STATES', () => {
    for (const [key, edges] of Object.entries(RESULT_EDGES)) {
      for (const edge of edges) {
        assert.ok(edge.name in STATES, `RESULT_EDGES['${key}'] outcome '${edge.name}' missing from STATES`);
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
    const reachable = findReachableActs(ACTS.BUILD, GRAPH);
    for (const actName of Object.keys(GRAPH)) {
      assert.ok(reachable.has(actName), `${actName} is unreachable from BUILD`);
    }
  });

  it('all work acts reachable from BUILD via BFS', () => {
    const reachable = findReachableActs(ACTS.BUILD, GRAPH);
    for (const actName of Object.keys(ACT_EXECUTOR)) {
      assert.ok(reachable.has(actName), `work act ${actName} is unreachable from BUILD`);
    }
  });

  it('RESUMED has no producer (external-only outcome)', () => {
    const orphans = findOrphanOutcomes(GRAPH, STATES);
    assert.ok(orphans.includes(OUTCOMES.RESUMED), 'RESUMED should be an orphan outcome');
  });

  it('STARTED has no producer (external-only outcome)', () => {
    const orphans = findOrphanOutcomes(GRAPH, STATES);
    assert.ok(orphans.includes(OUTCOMES.STARTED), 'STARTED should be an orphan outcome');
  });

  it('phase group outcomes are not orphans', () => {
    const orphans = findOrphanOutcomes(GRAPH, STATES);
    assert.ok(!orphans.includes(OUTCOMES.BUILDING), 'BUILDING should not be orphan');
    assert.ok(!orphans.includes(OUTCOMES.REVIEWING), 'REVIEWING should not be orphan');
    assert.ok(!orphans.includes(OUTCOMES.AWAITING_DEPLOY), 'AWAITING_DEPLOY should not be orphan');
    assert.ok(!orphans.includes(OUTCOMES.RELEASING), 'RELEASING should not be orphan');
  });

  it('validateGraph returns ok', () => {
    const result = validateGraph(GRAPH, STATES);
    assert.ok(result.ok, `Graph validation errors: ${result.errors.join(', ')}`);
  });

  it('buildTransitionGraph produces edges for all result types', () => {
    const { edges } = buildTransitionGraph(GRAPH);
    assert.ok(edges.length > 0, 'should have edges');

    // Every RESULT_EDGES key should appear as a via in the transition graph
    for (const key of Object.keys(RESULT_EDGES)) {
      const hasEdge = edges.some(e => e.via === key);
      assert.ok(hasEdge, `no edge for ${key}`);
    }
  });

  it('terminal edges have to=TERMINAL', () => {
    const { edges } = buildTransitionGraph(GRAPH);
    const terminals = edges.filter(e => e.type === 'terminal');
    for (const e of terminals) {
      assert.equal(e.to, 'TERMINAL', `terminal edge ${e.via} should have to=TERMINAL`);
    }
  });

  it('transition edges point to valid acts', () => {
    const { edges } = buildTransitionGraph(GRAPH);
    const transitions = edges.filter(e => e.type === 'transition');
    for (const e of transitions) {
      assert.ok(e.to in GRAPH, `transition edge ${e.via} points to unknown act ${e.to}`);
    }
  });

  it('auto-transition edges come from phase groups', () => {
    const { edges } = buildTransitionGraph(GRAPH);
    const autoEdges = edges.filter(e => e.type === 'auto');
    assert.ok(autoEdges.length === 4, `should have 4 auto-transition edges, got ${autoEdges.length}`);
    for (const e of autoEdges) {
      const node = GRAPH[e.from];
      assert.ok(node, `auto edge from unknown act ${e.from}`);
      assert.equal(node.executor, null, `auto edge ${e.from} should be a phase group`);
    }
  });
});

// ---------------------------------------------------------------------------
// Custom graph validation
// ---------------------------------------------------------------------------

describe('custom graph validation', () => {
  it('validates a valid custom graph', () => {
    const customGraph = {
      'Start': {
        label: 'Start',
        executor: null,
        results: {
          created: { outcomes: { name: 'Started', in: 'Start', next: 'Do' } },
        },
      },
      'Do': {
        label: 'Do Work',
        group: 'Start',
        executor: 'worker',
        results: {
          success: { outcomes: { name: 'Done' } },
        },
      },
    };
    const customStates = { 'Started': 'inProgress', 'Done': 'done' };
    const result = validateGraph(customGraph, customStates);
    assert.ok(result.ok, `Custom graph validation errors: ${result.errors.join(', ')}`);
  });

  it('rejects graph with missing outcome in states', () => {
    const customGraph = {
      'Start': {
        label: 'Start',
        executor: null,
        results: {
          created: { outcomes: { name: 'Started', in: 'Start', next: 'Do' } },
        },
      },
      'Do': {
        label: 'Do Work',
        group: 'Start',
        executor: 'worker',
        results: {
          success: { outcomes: { name: 'Done' } },
        },
      },
    };
    const customStates = { 'Started': 'inProgress' }; // Missing 'Done'
    const result = validateGraph(customGraph, customStates);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("'Done'")), 'should report missing Done state');
  });

  it('buildTransitionGraph works with custom graph', () => {
    const customGraph = {
      'A': {
        label: 'Phase A',
        executor: null,
        results: {
          created: { outcomes: { name: 'ACreated', in: 'Phase A', next: 'B' } },
        },
      },
      'B': {
        label: 'Step B',
        group: 'Phase A',
        executor: 'doB',
        results: {
          success: { outcomes: { name: 'BDone' } },
        },
      },
    };
    const { edges } = buildTransitionGraph(customGraph);
    assert.equal(edges.length, 2);
    assert.ok(edges.some(e => e.from === 'A' && e.to === 'B' && e.type === 'auto'));
    assert.ok(edges.some(e => e.from === 'B' && e.to === 'TERMINAL' && e.type === 'terminal'));
  });

  it('findReachableActs works with custom graph', () => {
    const customGraph = {
      'X': {
        label: 'X',
        executor: null,
        results: { created: { outcomes: { name: 'XCreated', next: 'Y' } } },
      },
      'Y': {
        label: 'Y',
        executor: 'doY',
        results: { success: { outcomes: { name: 'YDone' } } },
      },
      'Z': {
        label: 'Z',
        executor: 'doZ',
        results: { success: { outcomes: { name: 'ZDone' } } },
      },
    };
    const reachable = findReachableActs('X', customGraph);
    assert.ok(reachable.has('X'));
    assert.ok(reachable.has('Y'));
    assert.equal(reachable.has('Z'), false, 'Z should be unreachable');
  });
});
