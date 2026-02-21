import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH, ACT_EXECUTOR, RESULT_EDGES, RESULT_OUTCOMES, NEXT_ACT, STATES,
} from '../src/machine.js';
import { OUTCOMES, ACTS } from '../src/names.js';

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

describe('GRAPH', () => {
  it('every node has label and results', () => {
    for (const [act, node] of Object.entries(GRAPH)) {
      assert.ok(typeof node.label === 'string' && node.label.length > 0, `${act} missing label`);
      assert.ok(typeof node.results === 'object' && Object.keys(node.results).length > 0, `${act} missing results`);
    }
  });

  it('every result has outcomes with name', () => {
    for (const [act, node] of Object.entries(GRAPH)) {
      for (const [resultType, result] of Object.entries(node.results)) {
        assert.ok(result.outcomes, `${act}:${resultType} missing outcomes`);
        const outcomes = normalizeOutcomes(result.outcomes);
        for (const oc of outcomes) {
          assert.ok(typeof oc.name === 'string', `${act}:${resultType} outcome missing name`);
        }
      }
    }
  });

  it('4 phase groups have executor: null and single created result', () => {
    const phases = [ACTS.BUILD, ACTS.REVIEW, ACTS.DEPLOY, ACTS.RELEASE];
    for (const act of phases) {
      const node = GRAPH[act];
      assert.ok(node, `GRAPH missing phase ${act}`);
      assert.equal(node.executor, null, `${act} should have executor: null`);
      const resultKeys = Object.keys(node.results);
      assert.equal(resultKeys.length, 1, `${act} should have exactly 1 result`);
      assert.equal(resultKeys[0], 'created', `${act} result should be 'created'`);
    }
  });

  it('work acts have non-null executor', () => {
    const workActs = [ACTS.IMPLEMENT, ACTS.AWAIT_REPLY, ACTS.EVALUATE, ACTS.REVISE, ACTS.MERGE, ACTS.AWAIT_DEPLOY, ACTS.RUN_DEPLOY, ACTS.PUBLISH];
    for (const act of workActs) {
      const node = GRAPH[act];
      assert.ok(node, `GRAPH missing ${act}`);
      assert.ok(typeof node.executor === 'string', `${act} should have string executor`);
    }
  });

  it('every in value is Issue or matches a GRAPH label', () => {
    const graphLabels = new Set(Object.values(GRAPH).map(n => n.label));
    for (const [act, node] of Object.entries(GRAPH)) {
      for (const [resultType, result] of Object.entries(node.results)) {
        const outcomes = normalizeOutcomes(result.outcomes);
        for (const oc of outcomes) {
          if (oc.in !== undefined) {
            assert.ok(
              oc.in === 'Issue' || graphLabels.has(oc.in),
              `${act}:${resultType} 'in' = '${oc.in}' is not 'Issue' and not a GRAPH label`
            );
          }
        }
      }
    }
  });

  it('cross-phase transitions record on both phase group and Issue Run', () => {
    // Edges with in: 'Issue' + next should also have a sibling outcome on the phase group
    const crossPhase = [
      { act: ACTS.IMPLEMENT, result: 'success', phase: 'Build' },
      { act: ACTS.MERGE, result: 'success', phase: 'Review' },
      { act: ACTS.RUN_DEPLOY, result: 'success', phase: 'Deploy' },
      { act: ACTS.PUBLISH, result: 'success', phase: 'Release' },
    ];
    for (const { act, result, phase } of crossPhase) {
      const outcomes = normalizeOutcomes(GRAPH[act].results[result].outcomes);
      assert.ok(outcomes.length >= 2, `${act}:${result} should have multiple outcomes`);
      assert.ok(outcomes.some(o => o.in === phase), `${act}:${result} should record on ${phase}`);
      const issueOc = outcomes.find(o => !o.in || o.in === 'Issue');
      assert.ok(issueOc, `${act}:${result} should record on Issue Run`);
    }
  });

  it('derived ACT_EXECUTOR matches GRAPH (work acts only)', () => {
    for (const [act, node] of Object.entries(GRAPH)) {
      if (node.executor === null) {
        assert.ok(!(act in ACT_EXECUTOR), `${act} is a phase group, should not be in ACT_EXECUTOR`);
      } else {
        assert.equal(ACT_EXECUTOR[act], node.executor);
      }
    }
  });

  it('derived RESULT_EDGES matches GRAPH (work acts only)', () => {
    for (const [, node] of Object.entries(GRAPH)) {
      if (node.executor === null) continue;
      for (const [resultType, result] of Object.entries(node.results)) {
        const key = `${node.executor}:${resultType}`;
        const expected = normalizeOutcomes(result.outcomes);
        assert.deepEqual(RESULT_EDGES[key], expected);
      }
    }
  });

  it('derived RESULT_OUTCOMES is last outcome name from RESULT_EDGES', () => {
    for (const [key, edges] of Object.entries(RESULT_EDGES)) {
      assert.equal(RESULT_OUTCOMES[key], edges[edges.length - 1].name);
    }
  });

  it('derived NEXT_ACT is the next from edges with next, or null', () => {
    for (const [key, edges] of Object.entries(RESULT_EDGES)) {
      const withNext = edges.find(e => e.next);
      assert.equal(NEXT_ACT[key], withNext?.next || null);
    }
  });
});

describe('ACT_EXECUTOR', () => {
  const expected = [
    [ACTS.IMPLEMENT, 'implement'],
    [ACTS.AWAIT_REPLY, 'await_reply'],
    [ACTS.EVALUATE, 'review'],
    [ACTS.REVISE, 'revise'],
    [ACTS.MERGE, 'merge'],
    [ACTS.AWAIT_DEPLOY, 'await_deploy'],
    [ACTS.RUN_DEPLOY, 'deploy'],
    [ACTS.PUBLISH, 'release'],
  ];

  for (const [act, executor] of expected) {
    it(`${act} → ${executor}`, () => {
      assert.equal(ACT_EXECUTOR[act], executor);
    });
  }

  it('phase groups are excluded', () => {
    assert.equal(ACT_EXECUTOR[ACTS.BUILD], undefined);
    assert.equal(ACT_EXECUTOR[ACTS.REVIEW], undefined);
    assert.equal(ACT_EXECUTOR[ACTS.DEPLOY], undefined);
    assert.equal(ACT_EXECUTOR[ACTS.RELEASE], undefined);
  });
});

describe('RESULT_EDGES', () => {
  it('implement:success has 2 outcomes (Build + Issue)', () => {
    const edges = RESULT_EDGES['implement:success'];
    assert.equal(edges.length, 2);
    assert.equal(edges[0].in, 'Build');
    assert.equal(edges[0].next, undefined);
    assert.equal(edges[1].in, 'Issue');
    assert.equal(edges[1].next, ACTS.REVIEW);
  });

  it('implement:max_turns has 1 outcome on Build with next', () => {
    const edges = RESULT_EDGES['implement:max_turns'];
    assert.equal(edges.length, 1);
    assert.equal(edges[0].in, 'Build');
    assert.equal(edges[0].next, ACTS.IMPLEMENT);
  });

  it('implement:error has 1 outcome with no next (terminal)', () => {
    const edges = RESULT_EDGES['implement:error'];
    assert.equal(edges.length, 1);
    assert.equal(edges[0].next, undefined);
  });

  it('merge:success has 2 outcomes (Review + Issue)', () => {
    const edges = RESULT_EDGES['merge:success'];
    assert.equal(edges.length, 2);
    assert.equal(edges[0].in, 'Review');
    assert.equal(edges[1].in, 'Issue');
    assert.equal(edges[1].next, ACTS.DEPLOY);
  });

  it('deploy:success has 2 outcomes (Deploy + Issue)', () => {
    const edges = RESULT_EDGES['deploy:success'];
    assert.equal(edges.length, 2);
    assert.equal(edges[0].in, 'Deploy');
    assert.equal(edges[1].in, 'Issue');
    assert.equal(edges[1].next, ACTS.RELEASE);
  });

  it('release:success has 2 outcomes (Release + Issue Run)', () => {
    const edges = RESULT_EDGES['release:success'];
    assert.equal(edges.length, 2);
    assert.equal(edges[0].in, 'Release');
    assert.equal(edges[1].in, undefined); // Issue Run (no in = default)
  });
});

describe('RESULT_OUTCOMES', () => {
  const expected = [
    ['implement:success', OUTCOMES.PR_CREATED],
    ['implement:error', OUTCOMES.IMPLEMENTATION_FAILED],
    ['implement:ask_user', OUTCOMES.NEEDS_CLARIFICATION],
    ['implement:max_turns', OUTCOMES.PAUSED],
    ['review:approved', OUTCOMES.APPROVED],
    ['review:changes_requested', OUTCOMES.CHANGES_REQUESTED],
    ['review:error', OUTCOMES.FAILED],
    ['review:max_retries', OUTCOMES.FAILED],
    ['revise:success', OUTCOMES.FIXES_APPLIED],
    ['revise:error', OUTCOMES.REVISION_FAILED],
    ['revise:max_retries', OUTCOMES.MAX_RETRIES],
    ['merge:success', OUTCOMES.MERGED],
    ['merge:error', OUTCOMES.MERGE_FAILED],
    ['await_deploy:approved', OUTCOMES.DEPLOY_APPROVED],
    ['await_deploy:waiting', OUTCOMES.AWAITING_DEPLOY],
    ['await_reply:replied', OUTCOMES.CLARIFIED],
    ['await_reply:waiting', OUTCOMES.WAITING],
    ['deploy:success', OUTCOMES.DEPLOYED],
    ['deploy:error', OUTCOMES.DEPLOY_FAILED],
    ['release:success', OUTCOMES.RELEASED],
    ['release:error', OUTCOMES.RELEASE_FAILED],
  ];

  for (const [key, outcome] of expected) {
    it(`${key} → ${outcome}`, () => {
      assert.equal(RESULT_OUTCOMES[key], outcome);
    });
  }
});

describe('NEXT_ACT', () => {
  const expected = [
    ['implement:success', ACTS.REVIEW],
    ['implement:error', null],
    ['implement:ask_user', ACTS.AWAIT_REPLY],
    ['implement:max_turns', ACTS.IMPLEMENT],
    ['review:approved', ACTS.MERGE],
    ['review:changes_requested', ACTS.REVISE],
    ['review:error', ACTS.EVALUATE],
    ['review:max_retries', null],
    ['revise:success', ACTS.EVALUATE],
    ['revise:error', null],
    ['revise:max_retries', null],
    ['merge:success', ACTS.DEPLOY],
    ['merge:error', null],
    ['await_deploy:approved', ACTS.RUN_DEPLOY],
    ['await_deploy:waiting', ACTS.AWAIT_DEPLOY],
    ['await_reply:replied', ACTS.IMPLEMENT],
    ['await_reply:waiting', ACTS.AWAIT_REPLY],
    ['deploy:success', ACTS.RELEASE],
    ['deploy:error', ACTS.AWAIT_DEPLOY],
    ['release:success', null],
    ['release:error', ACTS.PUBLISH],
  ];

  for (const [key, nextAct] of expected) {
    it(`${key} → ${nextAct ?? 'null (terminal)'}`, () => {
      assert.equal(NEXT_ACT[key], nextAct);
    });
  }
});

describe('STATES', () => {
  it('covers all outcome names in RESULT_EDGES', () => {
    for (const [key, edges] of Object.entries(RESULT_EDGES)) {
      for (const edge of edges) {
        assert.ok(edge.name in STATES, `STATES missing '${edge.name}' from ${key}`);
      }
    }
  });

  it('covers all phase group outcomes', () => {
    for (const [act, node] of Object.entries(GRAPH)) {
      if (node.executor !== null) continue;
      for (const result of Object.values(node.results)) {
        const outcomes = normalizeOutcomes(result.outcomes);
        for (const oc of outcomes) {
          assert.ok(oc.name in STATES, `STATES missing phase outcome '${oc.name}' from ${act}`);
        }
      }
    }
  });

  it('most terminal outcomes map to done or blocked', () => {
    const exceptions = new Set([OUTCOMES.DEPLOY_FAILED]);
    for (const [key, nextAct] of Object.entries(NEXT_ACT)) {
      if (nextAct !== null) continue;
      const outcome = RESULT_OUTCOMES[key];
      if (exceptions.has(outcome)) continue;
      const column = STATES[outcome];
      assert.ok(
        column === 'done' || column === 'blocked',
        `Terminal outcome '${outcome}' maps to '${column}', expected 'done' or 'blocked'`
      );
    }
  });

  const expected = [
    [OUTCOMES.STARTED, 'todo'],
    [OUTCOMES.PR_CREATED, 'inReview'],
    [OUTCOMES.FIXES_APPLIED, 'inReview'],
    [OUTCOMES.CHANGES_REQUESTED, 'inProgress'],
    [OUTCOMES.APPROVED, 'inReview'],
    [OUTCOMES.NEEDS_CLARIFICATION, 'waiting'],
    [OUTCOMES.CLARIFIED, 'inProgress'],
    [OUTCOMES.PAUSED, 'blocked'],
    [OUTCOMES.WAITING, 'waiting'],
    [OUTCOMES.MERGED, 'readyForDeploy'],
    [OUTCOMES.AWAITING_DEPLOY, 'readyForDeploy'],
    [OUTCOMES.DEPLOY_APPROVED, 'deploy'],
    [OUTCOMES.DEPLOYED, 'deploy'],
    [OUTCOMES.DEPLOY_FAILED, 'blocked'],
    [OUTCOMES.RELEASED, 'done'],
    [OUTCOMES.RELEASE_FAILED, 'blocked'],
    [OUTCOMES.IMPLEMENTATION_FAILED, 'blocked'],
    [OUTCOMES.REVISION_FAILED, 'blocked'],
    [OUTCOMES.MAX_RETRIES, 'blocked'],
    [OUTCOMES.MERGE_FAILED, 'blocked'],
    [OUTCOMES.FAILED, 'blocked'],
    [OUTCOMES.RESUMED, 'inProgress'],
    [OUTCOMES.SHIPPED, 'done'],
    [OUTCOMES.ABORTED, 'blocked'],
    [OUTCOMES.BUILDING, 'inProgress'],
    [OUTCOMES.REVIEWING, 'inReview'],
    [OUTCOMES.RELEASING, 'deploy'],
  ];

  for (const [outcome, col] of expected) {
    it(`${outcome} → ${col}`, () => {
      assert.equal(STATES[outcome], col);
    });
  }
});
