import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEdges, availableTriggers, executeTrigger } from './ops.js';
import { GRAPH, STATES, TRIGGERS, CHECKPOINTS } from './machine.js';
import { OUTCOMES, ACTS } from './names.js';
import { normalizeOutcomes } from './index.js';

// ---------------------------------------------------------------------------
// Mock warp client factory
// ---------------------------------------------------------------------------

let ocCounter = 0;

function createMockWarp() {
  const calls = [];
  ocCounter = 0;

  return {
    calls,
    batchOutcome: (apiKey, opts) => {
      const id = `boc-${++ocCounter}`;
      calls.push({ name: 'batchOutcome', args: [apiKey, opts] });
      return { outcomeId: id };
    },
    batchAct: (apiKey, opts) => {
      calls.push({ name: 'batchAct', args: [apiKey, opts] });
      return { actId: 'next-act-1' };
    },
    batchFlush: async (apiKey) => {
      calls.push({ name: 'batchFlush', args: [apiKey] });
    },
  };
}

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    issueId: 42,
    repo: 'owner/repo',
    title: 'Test issue',
    latestOutcome: OUTCOMES.STARTED,
    outcomes: [],
    pendingAct: null,
    groups: new Map(),
    ...overrides,
  };
}

function batchOutcomes(calls) {
  return calls.filter(c => c.name === 'batchOutcome');
}

function oc(name, acts = []) {
  return { name, acts: acts.map(a => ({ name: a.name, opts: a.opts || {} })) };
}

// ---------------------------------------------------------------------------
// resolveEdges
// ---------------------------------------------------------------------------

describe('resolveEdges', () => {
  it('single edge records on Issue Run (no in)', () => {
    const warp = createMockWarp();
    const edges = [{ name: 'Implementation Failed' }];
    const run = makeRun();

    const result = resolveEdges(warp, 'key', edges, run, {});

    const ocs = batchOutcomes(warp.calls);
    assert.equal(ocs.length, 1);
    assert.equal(ocs[0].args[1].runId, 'run-1');
    assert.equal(ocs[0].args[1].name, 'Implementation Failed');
    assert.equal(result.nextAct, null);
    assert.equal(result.boardOutcomeName, 'Implementation Failed');
  });

  it('multi-edge result records on group and Issue Run', () => {
    const warp = createMockWarp();
    const edges = normalizeOutcomes(GRAPH[ACTS.IMPLEMENT].results.success.outcomes);
    const run = makeRun({ groups: new Map([['Build', 'build-group-1']]) });

    const result = resolveEdges(warp, 'key', edges, run, {
      nextActOpts: { prs: [], release: [] },
    });

    const ocs = batchOutcomes(warp.calls);
    // First outcome on Build group
    assert.equal(ocs[0].args[1].runId, 'build-group-1');
    assert.equal(ocs[0].args[1].name, OUTCOMES.PR_CREATED);
    // Second outcome on Issue Run (in: Issue)
    assert.equal(ocs[1].args[1].runId, 'run-1');
    assert.equal(ocs[1].args[1].name, OUTCOMES.PR_CREATED);
    // No mirror needed since we already recorded on Issue Run
    assert.equal(ocs.length, 2);

    assert.ok(result.nextAct);
    assert.equal(result.nextAct.name, ACTS.REVIEW);
    assert.equal(result.boardOutcomeName, OUTCOMES.PR_CREATED);
  });

  it('mirrors last outcome on Issue Run when not recorded there', () => {
    const warp = createMockWarp();
    // Single edge on a phase group only
    const edges = [{ name: 'Approved', in: 'Review' }];
    const run = makeRun({ groups: new Map([['Review', 'review-group-1']]) });

    resolveEdges(warp, 'key', edges, run, {});

    const ocs = batchOutcomes(warp.calls);
    assert.equal(ocs.length, 2);
    assert.equal(ocs[0].args[1].runId, 'review-group-1');
    assert.equal(ocs[1].args[1].runId, 'run-1'); // mirror
    assert.equal(ocs[1].args[1].name, 'Approved');
  });

  it('passes outcomeOpts through', () => {
    const warp = createMockWarp();
    const edges = [{ name: 'Done' }];
    const run = makeRun();
    const opts = { status: 'success', cost_usd: '0.50' };

    resolveEdges(warp, 'key', edges, run, { outcomeOpts: opts });

    const ocs = batchOutcomes(warp.calls);
    assert.deepEqual(ocs[0].args[1].opts, opts);
  });
});

// ---------------------------------------------------------------------------
// availableTriggers
// ---------------------------------------------------------------------------

describe('availableTriggers', () => {
  it('shows act trigger only when pending act matches', () => {
    const run = makeRun({
      pendingAct: { name: ACTS.AWAIT_DEPLOY, opts: {} },
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const names = available.map(t => t.name);

    assert.ok(names.includes('deploy'), 'should include deploy trigger');
    assert.ok(!names.includes('reply'), 'should not include reply trigger');
  });

  it('shows reply trigger when pending act is Await Reply', () => {
    const run = makeRun({
      pendingAct: { name: ACTS.AWAIT_REPLY, opts: {} },
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const names = available.map(t => t.name);

    assert.ok(names.includes('reply'));
    assert.ok(!names.includes('deploy'));
  });

  it('global triggers always show', () => {
    const run = makeRun({
      pendingAct: { name: ACTS.IMPLEMENT, opts: {} },
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const names = available.map(t => t.name);

    assert.ok(names.includes('cancel'));
    assert.ok(names.includes('ship'));
  });

  it('reset trigger shows only when no pending act and checkpoint exists', () => {
    const buildOpts = { repo: 'r', issue: '42', title: 'T' };
    const run = makeRun({
      pendingAct: null,
      outcomes: [
        oc(OUTCOMES.STARTED, [{ name: ACTS.BUILD, opts: buildOpts }]),
        oc(OUTCOMES.IMPLEMENTATION_FAILED),
      ],
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const names = available.map(t => t.name);

    assert.ok(names.includes('reset'));
  });

  it('reset trigger hidden when pending act exists', () => {
    const run = makeRun({
      pendingAct: { name: ACTS.IMPLEMENT, opts: {} },
      outcomes: [
        oc(OUTCOMES.STARTED, [{ name: ACTS.BUILD }]),
      ],
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const names = available.map(t => t.name);

    assert.ok(!names.includes('reset'));
  });

  it('reset trigger hidden when no recovery target', () => {
    const run = makeRun({
      pendingAct: null,
      outcomes: [oc(OUTCOMES.IMPLEMENTATION_FAILED)],
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const names = available.map(t => t.name);

    assert.ok(!names.includes('reset'));
  });

  it('returns label and type for each trigger', () => {
    const run = makeRun({
      pendingAct: { name: ACTS.AWAIT_DEPLOY, opts: {} },
    });

    const available = availableTriggers(TRIGGERS, run, CHECKPOINTS);
    const deploy = available.find(t => t.name === 'deploy');

    assert.ok(deploy);
    assert.equal(deploy.label, 'Approve Deploy');
    assert.equal(deploy.type, 'act');
  });
});

// ---------------------------------------------------------------------------
// executeTrigger
// ---------------------------------------------------------------------------

describe('executeTrigger', () => {
  const compiled = { graph: GRAPH, triggers: TRIGGERS, states: STATES, checkpoints: CHECKPOINTS };

  it('act trigger (deploy): resolves edges from Await Deploy.results.approved', async () => {
    const warp = createMockWarp();
    const run = makeRun({
      pendingAct: { name: ACTS.AWAIT_DEPLOY, opts: { prs: [], release: [] } },
      groups: new Map([['Deploy', 'deploy-group-1']]),
    });

    const result = await executeTrigger(warp, 'key', compiled, run, 'deploy');

    const ocs = batchOutcomes(warp.calls);
    // Should emit Deploy Approved on Deploy group
    const deployOc = ocs.find(c => c.args[1].runId === 'deploy-group-1');
    assert.ok(deployOc);
    assert.equal(deployOc.args[1].name, OUTCOMES.DEPLOY_APPROVED);

    // Should emit next act (Run Deploy)
    const actCall = warp.calls.find(c => c.name === 'batchAct');
    assert.ok(actCall);
    assert.equal(actCall.args[1].name, ACTS.RUN_DEPLOY);

    assert.ok(result.nextAct);
    assert.equal(result.nextAct.name, ACTS.RUN_DEPLOY);
    assert.equal(result.boardOutcomeName, OUTCOMES.DEPLOY_APPROVED);

    // Should flush
    assert.ok(warp.calls.find(c => c.name === 'batchFlush'));
  });

  it('act trigger (reply): resolves edges from Await Reply.results.replied', async () => {
    const warp = createMockWarp();
    const run = makeRun({
      pendingAct: { name: ACTS.AWAIT_REPLY, opts: {} },
      groups: new Map([['Build', 'build-group-1']]),
    });

    const result = await executeTrigger(warp, 'key', compiled, run, 'reply');

    const ocs = batchOutcomes(warp.calls);
    const groupOc = ocs.find(c => c.args[1].runId === 'build-group-1');
    assert.ok(groupOc);
    assert.equal(groupOc.args[1].name, OUTCOMES.CLARIFIED);

    assert.ok(result.nextAct);
    assert.equal(result.nextAct.name, ACTS.IMPLEMENT);
  });

  it('global trigger (cancel): emits single terminal outcome', async () => {
    const warp = createMockWarp();
    const run = makeRun();

    const result = await executeTrigger(warp, 'key', compiled, run, 'cancel');

    const ocs = batchOutcomes(warp.calls);
    assert.equal(ocs.length, 1);
    assert.equal(ocs[0].args[1].runId, 'run-1');
    assert.equal(ocs[0].args[1].name, OUTCOMES.CANCELLED);

    assert.equal(result.nextAct, null);
    assert.equal(result.boardOutcomeName, OUTCOMES.CANCELLED);
    assert.ok(warp.calls.find(c => c.name === 'batchFlush'));
  });

  it('global trigger (ship): emits Manual Release outcome', async () => {
    const warp = createMockWarp();
    const run = makeRun();

    const result = await executeTrigger(warp, 'key', compiled, run, 'ship');

    const ocs = batchOutcomes(warp.calls);
    assert.equal(ocs.length, 1);
    assert.equal(ocs[0].args[1].name, OUTCOMES.MANUAL_RELEASE);
    assert.equal(result.boardOutcomeName, OUTCOMES.MANUAL_RELEASE);
  });

  it('reset trigger: emits Interrupted + Resumed + checkpoint act', async () => {
    const warp = createMockWarp();
    const buildOpts = { repo: 'r', issue: '42', title: 'T' };
    const run = makeRun({
      pendingAct: null,
      groups: new Map([['Build', 'build-group-1']]),
      outcomes: [
        oc(OUTCOMES.STARTED, [{ name: ACTS.BUILD, opts: buildOpts }]),
        oc(OUTCOMES.BUILDING),
        oc(OUTCOMES.IMPLEMENTATION_FAILED),
      ],
    });

    const result = await executeTrigger(warp, 'key', compiled, run, 'reset');

    const ocs = batchOutcomes(warp.calls);
    // Interrupted on stuck group
    const interruptedOc = ocs.find(c => c.args[1].name === OUTCOMES.INTERRUPTED);
    assert.ok(interruptedOc);
    assert.equal(interruptedOc.args[1].runId, 'build-group-1');

    // Resumed on Issue Run
    const resumedOc = ocs.find(c => c.args[1].name === OUTCOMES.RESUMED);
    assert.ok(resumedOc);
    assert.equal(resumedOc.args[1].runId, 'run-1');

    // Interrupted before Resumed
    const interruptedIdx = warp.calls.indexOf(warp.calls.find(c => c.name === 'batchOutcome' && c.args[1].name === OUTCOMES.INTERRUPTED));
    const resumedIdx = warp.calls.indexOf(warp.calls.find(c => c.name === 'batchOutcome' && c.args[1].name === OUTCOMES.RESUMED));
    assert.ok(interruptedIdx < resumedIdx);

    // Checkpoint act emitted
    const actCall = warp.calls.find(c => c.name === 'batchAct');
    assert.ok(actCall);
    assert.equal(actCall.args[1].name, ACTS.BUILD);
    assert.deepEqual(actCall.args[1].opts, buildOpts);

    assert.equal(result.boardOutcomeName, OUTCOMES.RESUMED);
    assert.equal(result.nextAct.name, ACTS.BUILD);
    assert.deepEqual(result.nextAct.opts, buildOpts);

    assert.ok(warp.calls.find(c => c.name === 'batchFlush'));
  });

  it('reset trigger skips Interrupted when no group for phase', async () => {
    const warp = createMockWarp();
    const run = makeRun({
      pendingAct: null,
      groups: new Map(),
      outcomes: [
        oc(OUTCOMES.STARTED, [{ name: ACTS.BUILD, opts: { repo: 'r', issue: '42', title: 'T' } }]),
        oc(OUTCOMES.IMPLEMENTATION_FAILED),
      ],
    });

    await executeTrigger(warp, 'key', compiled, run, 'reset');

    const ocs = batchOutcomes(warp.calls);
    const interruptedOc = ocs.find(c => c.args[1].name === OUTCOMES.INTERRUPTED);
    assert.equal(interruptedOc, undefined, 'should not emit INTERRUPTED when no group');

    const resumedOc = ocs.find(c => c.args[1].name === OUTCOMES.RESUMED);
    assert.ok(resumedOc, 'should still emit RESUMED');
  });

  it('reset trigger with phase override', async () => {
    const warp = createMockWarp();
    const buildOpts = { repo: 'r', issue: '42', title: 'T' };
    const reviewOpts = { prs: [{ repo: 'r', prNumber: 1 }] };
    const run = makeRun({
      pendingAct: null,
      outcomes: [
        oc(OUTCOMES.STARTED, [{ name: ACTS.BUILD, opts: buildOpts }]),
        oc(OUTCOMES.PR_CREATED, [{ name: ACTS.REVIEW, opts: reviewOpts }]),
        oc(OUTCOMES.REVIEW_FAILED),
      ],
    });

    // Without phase override, would pick Review (last checkpoint)
    const result = await executeTrigger(warp, 'key', compiled, run, 'reset', { phase: ACTS.BUILD });

    assert.equal(result.nextAct.name, ACTS.BUILD);
    assert.deepEqual(result.nextAct.opts, buildOpts);
  });

  it('reset trigger throws when no recovery target', async () => {
    const warp = createMockWarp();
    const run = makeRun({
      pendingAct: null,
      outcomes: [oc(OUTCOMES.IMPLEMENTATION_FAILED)],
    });

    await assert.rejects(
      () => executeTrigger(warp, 'key', compiled, run, 'reset'),
      /No recovery target found/,
    );
  });

  it('throws on unknown trigger name', async () => {
    const warp = createMockWarp();
    const run = makeRun();

    await assert.rejects(
      () => executeTrigger(warp, 'key', compiled, run, 'nonexistent'),
      /Unknown trigger/,
    );
  });
});
