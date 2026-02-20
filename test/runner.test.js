import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.js';
import { OUTCOMES, ACTS } from '../src/names.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMocks() {
  const calls = [];

  const warp = {
    startPipeline: async (apiKey, opts) => {
      calls.push({ name: 'startPipeline', args: [apiKey, opts] });
      return { runId: 'r1' };
    },
    createGroup: async (apiKey, opts) => { calls.push({ name: 'createGroup', args: [apiKey, opts] }); return { groupId: 'sg1' }; },
    traceClaudeCall: async () => {},
    recordOutcome: async (apiKey, ids, opts) => {
      calls.push({ name: 'recordOutcome', args: [apiKey, ids, opts] });
      return { id: 'oc1', runOutcomeId: 'roc1', name: opts.step };
    },
    emitAct: async (apiKey, opts) => { calls.push({ name: 'emitAct', args: [apiKey, opts] }); return { actId: 'next-act-1' }; },
    recordIssueOutcome: async (apiKey, opts) => {
      calls.push({ name: 'recordIssueOutcome', args: [apiKey, opts] });
      return { outcomeId: `ioc-${calls.length}` };
    },
    createIssueRun: async (apiKey, opts) => {
      calls.push({ name: 'createIssueRun', args: [apiKey, opts] });
      return { runId: 'new-run-1', actId: 'act1' };
    },
    findOpenIssueRuns: async () => [],
  };

  const board = {
    scanNewIssues: async () => [],
    syncState: async (item, column) => { calls.push({ name: 'syncState', args: [item, column] }); },
    getAllItems: async () => [],
  };

  const codehost = {};

  const config = {
    repoNames: ['owner/repo'],
    warpmetricsApiKey: 'wm_test',
    concurrency: 1,
  };

  const execute = {};
  const effects = {};
  const logs = [];

  return { warp, board, codehost, config, execute, effects, calls, logs,
    log: (id, msg) => logs.push({ id, msg }) };
}

function makeRun(overrides = {}) {
  // Build groups map from parentEntityId/Label if provided (backwards compat for tests).
  let groups = overrides.groups || new Map();
  if (!(groups instanceof Map)) groups = new Map(Object.entries(groups));
  if (overrides.parentEntityId && overrides.parentEntityLabel) {
    groups.set(overrides.parentEntityLabel, overrides.parentEntityId);
  }
  return {
    id: 'run-1', issueId: 42, repo: 'owner/repo', title: 'Test issue',
    latestOutcome: OUTCOMES.STARTED, outcomes: [],
    boardItem: { id: 'bi1', _issueId: 42 },
    pendingAct: { id: 'act-1', name: ACTS.BUILD, opts: { issueId: 42, repo: 'owner/repo', title: 'Test issue' } },
    groups,
    ...overrides,
    // Ensure groups is always the computed map, not the override.
    groups,
  };
}

// Helper: filter recordIssueOutcome calls
function issueOutcomes(calls) {
  return calls.filter(c => c.name === 'recordIssueOutcome');
}

// Helper to run a single processRun via poll
async function runSingle(m, run) {
  m.warp.findOpenIssueRuns = async () => [run];
  const runner = createRunner({ ...m, log: m.log });
  await runner.poll();
  await runner.waitForInFlight();
}

// ---------------------------------------------------------------------------
// Phase group auto-transition tests
// ---------------------------------------------------------------------------

describe('phase group auto-transition', () => {

  it('BUILD act creates group, records BUILDING, emits IMPLEMENT, syncs board', async () => {
    const m = createMocks();
    await runSingle(m, makeRun());

    const group = m.calls.find(c => c.name === 'createGroup');
    assert.ok(group, 'should create group');
    assert.equal(group.args[1].runId, 'run-1');
    assert.equal(group.args[1].label, 'Build');

    const ocs = issueOutcomes(m.calls);
    assert.ok(ocs.length >= 1);
    // First outcome on group
    assert.equal(ocs[0].args[1].name, OUTCOMES.BUILDING);
    assert.equal(ocs[0].args[1].runId, 'sg1');

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.ok(emitAct);
    assert.equal(emitAct.args[1].name, ACTS.IMPLEMENT);

    // Board sync on Issue Run
    const boardSync = ocs.find(c => c.args[1].runId === 'run-1');
    assert.ok(boardSync, 'should record on Issue Run for board sync');
    assert.equal(boardSync.args[1].name, OUTCOMES.BUILDING);
  });

  it('REVIEW act creates group, records REVIEWING, emits EVALUATE', async () => {
    const m = createMocks();
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.PR_CREATED,
      pendingAct: { id: 'act-2', name: ACTS.REVIEW, opts: { prs: [], release: [] } },
    }));

    const group = m.calls.find(c => c.name === 'createGroup');
    assert.equal(group.args[1].label, 'Review');

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.EVALUATE);
  });

  it('DEPLOY act creates group, records AWAITING_DEPLOY, emits AWAIT_DEPLOY', async () => {
    const m = createMocks();
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.MERGED,
      pendingAct: { id: 'act-5', name: ACTS.DEPLOY, opts: { prs: [], release: [] } },
    }));

    const group = m.calls.find(c => c.name === 'createGroup');
    assert.equal(group.args[1].label, 'Deploy');

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.AWAIT_DEPLOY);
  });

  it('RELEASE act creates group, records RELEASING, emits PUBLISH', async () => {
    const m = createMocks();
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.DEPLOYED,
      pendingAct: { id: 'act-7', name: ACTS.RELEASE, opts: { prs: [], release: [] } },
    }));

    const group = m.calls.find(c => c.name === 'createGroup');
    assert.equal(group.args[1].label, 'Release');

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.PUBLISH);
  });
});

// ---------------------------------------------------------------------------
// Work act tests
// ---------------------------------------------------------------------------

describe('processRun (act-driven)', () => {

  it('IMPLEMENT success → PR_CREATED on Build group + Issue Run, REVIEW emitted (cross-phase)', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0.5, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [{ repo: 'owner/repo', prNumber: 1 }], release: [] },
    });
    await runSingle(m, makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    const ocs = issueOutcomes(m.calls);
    // Should record on Build group first, then Issue Run
    const buildOc = ocs.find(c => c.args[1].runId === 'build-group-1');
    assert.ok(buildOc, 'should record PR_CREATED on Build group');
    assert.equal(buildOc.args[1].name, OUTCOMES.PR_CREATED);

    const issueOc = ocs.find(c => c.args[1].runId === 'run-1');
    assert.ok(issueOc, 'should record PR_CREATED on Issue Run');
    assert.equal(issueOc.args[1].name, OUTCOMES.PR_CREATED);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.REVIEW);

    const sync = m.calls.findLast(c => c.name === 'syncState');
    assert.equal(sync.args[1], 'inReview');
  });

  it('IMPLEMENT max_turns → PAUSED on Build group + board sync on Issue Run', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'max_turns', sessionId: 'sess1', costUsd: 0.5, trace: null, outcomeOpts: {},
      nextActOpts: { sessionId: 'sess1', retryCount: 1 },
    });
    await runSingle(m, makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    const ocs = issueOutcomes(m.calls);
    // Within-phase: recorded on Build group
    const groupOc = ocs.find(c => c.args[1].runId === 'build-group-1');
    assert.ok(groupOc);
    assert.equal(groupOc.args[1].name, OUTCOMES.PAUSED);

    // Board sync: implicit recording on Issue Run
    const issueOc = ocs.find(c => c.args[1].runId === 'run-1');
    assert.ok(issueOc, 'should board-sync on Issue Run');
    assert.equal(issueOc.args[1].name, OUTCOMES.PAUSED);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.IMPLEMENT);
    assert.equal(emitAct.args[1].opts.sessionId, 'sess1');
  });

  it('IMPLEMENT ask_user → NEEDS_CLARIFICATION on Build group + AWAIT_REPLY emitted + effect', async () => {
    const m = createMocks();
    let effectCalled = false;
    m.execute.implement = async () => ({
      type: 'ask_user', question: 'What?', costUsd: 0.1, trace: null, outcomeOpts: {},
      nextActOpts: {},
    });
    m.effects['implement:ask_user'] = async () => { effectCalled = true; };
    await runSingle(m, makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    assert.ok(effectCalled);
    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.AWAIT_REPLY);
  });

  it('IMPLEMENT error → IMPLEMENTATION_FAILED on Issue Run (terminal)', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'error', error: 'boom', costUsd: null, trace: null, outcomeOpts: {},
    });
    await runSingle(m, makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    const ocs = issueOutcomes(m.calls);
    // Terminal: no 'in' → Issue Run
    assert.equal(ocs[0].args[1].name, OUTCOMES.IMPLEMENTATION_FAILED);
    assert.equal(ocs[0].args[1].runId, 'run-1');

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct, undefined);

    const sync = m.calls.findLast(c => c.name === 'syncState');
    assert.equal(sync.args[1], 'blocked');
  });

  it('EVALUATE approved → APPROVED on Review group + MERGE emitted', async () => {
    const m = createMocks();
    m.execute.review = async () => ({
      type: 'approved', costUsd: 0.2, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.REVIEWING,
      pendingAct: { id: 'act-2', name: ACTS.EVALUATE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const ocs = issueOutcomes(m.calls);
    const groupOc = ocs.find(c => c.args[1].runId === 'review-group-1');
    assert.ok(groupOc);
    assert.equal(groupOc.args[1].name, OUTCOMES.APPROVED);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.MERGE);
  });

  it('EVALUATE changes_requested → CHANGES_REQUESTED + REVISE emitted', async () => {
    const m = createMocks();
    m.execute.review = async () => ({
      type: 'changes_requested', costUsd: 0.2, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.REVIEWING,
      pendingAct: { id: 'act-2', name: ACTS.EVALUATE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.REVISE);
  });

  it('EVALUATE error → FAILED on Review group + EVALUATE re-emitted', async () => {
    const m = createMocks();
    m.execute.review = async () => ({
      type: 'error', error: 'review failed', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.REVIEWING,
      pendingAct: { id: 'act-2', name: ACTS.EVALUATE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const ocs = issueOutcomes(m.calls);
    const groupOc = ocs.find(c => c.args[1].runId === 'review-group-1');
    assert.equal(groupOc.args[1].name, OUTCOMES.FAILED);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.EVALUATE);
  });

  it('AWAIT_REPLY replied → CLARIFIED on Build group + IMPLEMENT emitted', async () => {
    const m = createMocks();
    m.execute.await_reply = async () => ({
      type: 'replied', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: {},
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.NEEDS_CLARIFICATION,
      pendingAct: { id: 'act-3', name: ACTS.AWAIT_REPLY, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    const ocs = issueOutcomes(m.calls);
    const groupOc = ocs.find(c => c.args[1].runId === 'build-group-1');
    assert.ok(groupOc);
    assert.equal(groupOc.args[1].name, OUTCOMES.CLARIFIED);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.IMPLEMENT);
  });

  it('REVISE success → FIXES_APPLIED on Review group + EVALUATE emitted', async () => {
    const m = createMocks();
    m.execute.revise = async () => ({
      type: 'success', costUsd: 0.3, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.CHANGES_REQUESTED,
      pendingAct: { id: 'act-4', name: ACTS.REVISE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.EVALUATE);
  });

  it('REVISE error → REVISION_FAILED (terminal) + effect called', async () => {
    const m = createMocks();
    let effectCalled = false;
    m.execute.revise = async () => ({
      type: 'error', error: 'revision boom', costUsd: null, trace: null, outcomeOpts: {},
    });
    m.effects['revise:error'] = async () => { effectCalled = true; };
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.CHANGES_REQUESTED,
      pendingAct: { id: 'act-4', name: ACTS.REVISE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const ocs = issueOutcomes(m.calls);
    assert.equal(ocs[0].args[1].name, OUTCOMES.REVISION_FAILED);
    assert.ok(effectCalled);
  });

  it('MERGE success → MERGED on Review group + Issue Run, DEPLOY emitted (cross-phase)', async () => {
    const m = createMocks();
    let effectCalled = false;
    m.execute.merge = async () => ({
      type: 'success', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    m.effects['merge:success'] = async () => { effectCalled = true; };
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.APPROVED,
      pendingAct: { id: 'act-5', name: ACTS.MERGE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const ocs = issueOutcomes(m.calls);
    const reviewOc = ocs.find(c => c.args[1].runId === 'review-group-1');
    assert.ok(reviewOc, 'should record MERGED on Review group');
    assert.equal(reviewOc.args[1].name, OUTCOMES.MERGED);

    const issueOc = ocs.find(c => c.args[1].runId === 'run-1');
    assert.ok(issueOc, 'should record MERGED on Issue Run');
    assert.equal(issueOc.args[1].name, OUTCOMES.MERGED);

    assert.ok(effectCalled);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.DEPLOY);
  });

  it('MERGE error → MERGE_FAILED (terminal)', async () => {
    const m = createMocks();
    m.execute.merge = async () => ({
      type: 'error', error: 'merge boom', costUsd: null, trace: null, outcomeOpts: {},
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.APPROVED,
      pendingAct: { id: 'act-5', name: ACTS.MERGE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    const ocs = issueOutcomes(m.calls);
    assert.equal(ocs[0].args[1].name, OUTCOMES.MERGE_FAILED);
  });

  it('AWAIT_DEPLOY approved → DEPLOY_APPROVED on Deploy group + RUN_DEPLOY emitted', async () => {
    const m = createMocks();
    m.execute.await_deploy = async () => ({
      type: 'approved', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.AWAITING_DEPLOY,
      pendingAct: { id: 'act-6', name: ACTS.AWAIT_DEPLOY, opts: { prs: [], release: [] } },
      parentEntityId: 'deploy-group-1',
      parentEntityLabel: 'Deploy',
    }));

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.RUN_DEPLOY);
  });

  it('RUN_DEPLOY success → DEPLOYED on Deploy group + Issue Run, RELEASE emitted (cross-phase)', async () => {
    const m = createMocks();
    m.execute.deploy = async () => ({
      type: 'success', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.DEPLOY_APPROVED,
      pendingAct: { id: 'act-7', name: ACTS.RUN_DEPLOY, opts: { prs: [], release: [] } },
      parentEntityId: 'deploy-group-1',
      parentEntityLabel: 'Deploy',
    }));

    const ocs = issueOutcomes(m.calls);
    const deployOc = ocs.find(c => c.args[1].runId === 'deploy-group-1');
    assert.ok(deployOc, 'should record DEPLOYED on Deploy group');

    const issueOc = ocs.find(c => c.args[1].runId === 'run-1');
    assert.ok(issueOc, 'should record DEPLOYED on Issue Run');

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.RELEASE);
  });

  it('PUBLISH success → RELEASED on Release group + Issue Run (terminal, done)', async () => {
    const m = createMocks();
    m.execute.release = async () => ({
      type: 'success', costUsd: null, trace: null, outcomeOpts: {},
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.RELEASING,
      pendingAct: { id: 'act-8', name: ACTS.PUBLISH, opts: {} },
      parentEntityId: 'release-group-1',
      parentEntityLabel: 'Release',
    }));

    const ocs = issueOutcomes(m.calls);
    const releaseOc = ocs.find(c => c.args[1].runId === 'release-group-1');
    assert.ok(releaseOc, 'should record RELEASED on Release group');

    const issueOc = ocs.find(c => c.args[1].runId === 'run-1');
    assert.ok(issueOc, 'should record RELEASED on Issue Run');

    // No next act (terminal)
    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct, undefined);

    const sync = m.calls.findLast(c => c.name === 'syncState');
    assert.equal(sync.args[1], 'done');
  });

  it('PUBLISH error → RELEASE_FAILED on Release group + PUBLISH re-emitted', async () => {
    const m = createMocks();
    m.execute.release = async () => ({
      type: 'error', error: 'release boom', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: {},
    });
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.RELEASING,
      pendingAct: { id: 'act-8', name: ACTS.PUBLISH, opts: {} },
      parentEntityId: 'release-group-1',
      parentEntityLabel: 'Release',
    }));

    const ocs = issueOutcomes(m.calls);
    const groupOc = ocs.find(c => c.args[1].runId === 'release-group-1');
    assert.ok(groupOc);
    assert.equal(groupOc.args[1].name, OUTCOMES.RELEASE_FAILED);

    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.equal(emitAct.args[1].name, ACTS.PUBLISH);
  });

  it('no pendingAct → nothing happens', async () => {
    const m = createMocks();
    m.warp.findOpenIssueRuns = async () => [makeRun({ pendingAct: null })];
    const runner = createRunner({ ...m, log: m.log });

    const stats = await runner.poll();
    await runner.waitForInFlight();

    assert.equal(stats.processing, 0);
    assert.equal(issueOutcomes(m.calls).length, 0);
  });

  it('no board → no syncState call', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0.1, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    m.warp.findOpenIssueRuns = async () => [makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    })];
    const runner = createRunner({ ...m, board: null, log: m.log });

    await runner.poll();
    await runner.waitForInFlight();

    assert.equal(m.calls.filter(c => c.name === 'syncState').length, 0);
  });

  it('act.id is passed as refActId to startPipeline', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      pendingAct: { id: 'my-act-123', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    const pipeline = m.calls.find(c => c.name === 'startPipeline');
    assert.ok(pipeline);
    assert.equal(pipeline.args[1].refActId, 'my-act-123');
  });

  it('startPipeline creates run without auto-group', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    await runSingle(m, makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    }));

    const pipeline = m.calls.find(c => c.name === 'startPipeline');
    assert.ok(pipeline);
    // Trace and outcome go directly on the run (linked to act via refActId)
    assert.equal(pipeline.args[1].refActId, 'act-1');
  });
});

// ---------------------------------------------------------------------------
// poll tests
// ---------------------------------------------------------------------------

describe('poll', () => {
  it('intake: new board issues create issue runs', async () => {
    const m = createMocks();
    m.board.scanNewIssues = async () => [{ issueId: 99, repo: 'owner/repo', title: 'New issue' }];
    const runner = createRunner({ ...m, log: m.log });

    await runner.poll();

    const create = m.calls.find(c => c.name === 'createIssueRun');
    assert.ok(create);
    assert.equal(create.args[1].issueNumber, 99);
  });

  it('intake: skips issues that already have an open run', async () => {
    const m = createMocks();
    m.board.scanNewIssues = async () => [{ issueId: 42, repo: 'owner/repo', title: 'Existing issue' }];
    m.warp.findOpenIssueRuns = async () => [makeRun({ issueId: 42 })];
    const runner = createRunner({ ...m, log: m.log });

    await runner.poll();
    await runner.waitForInFlight();

    const create = m.calls.find(c => c.name === 'createIssueRun');
    assert.equal(create, undefined);
  });

  it('skips runs without pendingAct', async () => {
    const m = createMocks();
    m.warp.findOpenIssueRuns = async () => [makeRun({ pendingAct: null })];
    const runner = createRunner({ ...m, log: m.log });

    const stats = await runner.poll();
    await runner.waitForInFlight();

    assert.equal(stats.processing, 0);
  });

  it('abort: records ABORTED outcome when issue is in Aborted column', async () => {
    const m = createMocks();
    m.warp.findOpenIssueRuns = async () => [makeRun({ latestOutcome: OUTCOMES.PR_CREATED })];
    m.board.scanAborted = async () => new Set([42]);
    const runner = createRunner({ ...m, log: m.log });

    await runner.poll();
    await runner.waitForInFlight();

    const abortOcs = m.calls.filter(c => c.name === 'recordIssueOutcome' && c.args[1].name === OUTCOMES.ABORTED);
    assert.equal(abortOcs.length, 1);
    assert.equal(abortOcs[0].args[1].runId, 'run-1');
  });

  it('findDeployBatch is called for deploy executor and batch passed through', async () => {
    const m = createMocks();
    let batchCalled = false;
    let receivedBatch = null;
    m.execute.deploy = async (run, ctx) => {
      receivedBatch = ctx.deployBatch;
      return { type: 'success', costUsd: null, trace: null, outcomeOpts: {},
        nextActOpts: { prs: [], release: [] } };
    };
    const findDeployBatch = async (run, act) => {
      batchCalled = true;
      return { issueIds: [42, 99], issues: [
        { issueId: 42, runId: 'run-1' },
        { issueId: 99, runId: 'run-2' },
      ] };
    };
    m.warp.findOpenIssueRuns = async () => [makeRun({
      latestOutcome: OUTCOMES.DEPLOY_APPROVED,
      pendingAct: { id: 'act-7', name: ACTS.RUN_DEPLOY, opts: { prs: [], release: [] } },
      parentEntityId: 'deploy-group-1',
      parentEntityLabel: 'Deploy',
    })];
    const runner = createRunner({ ...m, findDeployBatch, log: m.log });
    await runner.poll();
    await runner.waitForInFlight();

    assert.ok(batchCalled, 'findDeployBatch should be called');
    assert.ok(receivedBatch, 'deploy executor should receive deployBatch');
    assert.deepEqual(receivedBatch.issueIds, [42, 99]);
  });

  it('findDeployBatch is NOT called for non-deploy executors', async () => {
    const m = createMocks();
    let batchCalled = false;
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    const findDeployBatch = async () => { batchCalled = true; return null; };
    m.warp.findOpenIssueRuns = async () => [makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    })];
    const runner = createRunner({ ...m, findDeployBatch, log: m.log });
    await runner.poll();
    await runner.waitForInFlight();

    assert.equal(batchCalled, false, 'findDeployBatch should not be called for implement');
  });

  it('deploy:success effect receives batchedIssues', async () => {
    const m = createMocks();
    let effectBatchedIssues = null;
    m.execute.deploy = async () => ({
      type: 'success', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
      batchedIssues: [{ issueId: 99, runId: 'run-2', parentEntityId: 'deploy-group-2' }],
    });
    m.effects['deploy:success'] = async (run, result) => {
      effectBatchedIssues = result.batchedIssues;
    };
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.DEPLOY_APPROVED,
      pendingAct: { id: 'act-7', name: ACTS.RUN_DEPLOY, opts: { prs: [], release: [] } },
      parentEntityId: 'deploy-group-1',
      parentEntityLabel: 'Deploy',
    }));

    assert.ok(effectBatchedIssues, 'effect should receive batchedIssues');
    assert.equal(effectBatchedIssues.length, 1);
    assert.equal(effectBatchedIssues[0].issueId, 99);
  });

  it('latestOutcome updates even without board', async () => {
    const m = createMocks();
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0.1, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    m.warp.findOpenIssueRuns = async () => [makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    })];
    const runner = createRunner({ ...m, board: null, log: m.log });

    await runner.poll();
    await runner.waitForInFlight();

    // latestOutcome should still be set even without board
    // Verified by checking the cross-phase act was emitted (REVIEW),
    // which only happens if latestOutcome is properly tracked
    const emitAct = m.calls.find(c => c.name === 'emitAct');
    assert.ok(emitAct, 'should emit next act even without board');
  });

  it('effect receives board in context', async () => {
    const m = createMocks();
    let effectCtx = null;
    m.execute.deploy = async () => ({
      type: 'success', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    m.effects['deploy:success'] = async (run, result, ctx) => {
      effectCtx = ctx;
    };
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.DEPLOY_APPROVED,
      pendingAct: { id: 'act-7', name: ACTS.RUN_DEPLOY, opts: { prs: [], release: [] } },
      parentEntityId: 'deploy-group-1',
      parentEntityLabel: 'Deploy',
    }));

    assert.ok(effectCtx, 'effect should be called');
    assert.ok('board' in effectCtx, 'effect context should include board');
    assert.ok('warp' in effectCtx, 'effect context should include warp');
    assert.ok('apiKey' in effectCtx, 'effect context should include apiKey');
  });

  it('waiting acts are capped to prevent flooding', async () => {
    const m = createMocks();
    let callCount = 0;
    m.execute.await_deploy = async () => {
      callCount++;
      return { type: 'waiting' };
    };

    // Create 15 waiting runs (more than default cap of max(1*5, 10) = 10)
    const runs = [];
    for (let i = 0; i < 15; i++) {
      runs.push(makeRun({
        id: `run-${i}`, issueId: 100 + i,
        latestOutcome: OUTCOMES.AWAITING_DEPLOY,
        pendingAct: { id: `act-${i}`, name: ACTS.AWAIT_DEPLOY, opts: { prs: [], release: [] } },
        parentEntityId: `deploy-group-${i}`,
        parentEntityLabel: 'Deploy',
      }));
    }

    m.warp.findOpenIssueRuns = async () => runs;
    const runner = createRunner({ ...m, log: m.log });
    await runner.poll();
    await runner.waitForInFlight();

    // With concurrency=1, maxWaiting = max(1*5, 10) = 10, so at most 10 should be processed
    assert.ok(callCount <= 10, `expected at most 10 waiting acts processed, got ${callCount}`);
    assert.ok(callCount > 0, 'should process some waiting acts');
  });

  it('effect exception does not prevent board sync or latestOutcome', async () => {
    const m = createMocks();
    m.execute.merge = async () => ({
      type: 'success', costUsd: null, trace: null, outcomeOpts: {},
      nextActOpts: { prs: [], release: [] },
    });
    m.effects['merge:success'] = async () => { throw new Error('effect boom'); };
    await runSingle(m, makeRun({
      latestOutcome: OUTCOMES.APPROVED,
      pendingAct: { id: 'act-5', name: ACTS.MERGE, opts: { prs: [], release: [] } },
      parentEntityId: 'review-group-1',
      parentEntityLabel: 'Review',
    }));

    // Board sync should still have happened
    const sync = m.calls.findLast(c => c.name === 'syncState');
    assert.ok(sync, 'board sync should happen despite effect error');
  });

  it('headless mode: no board operations', async () => {
    const m = createMocks();
    m.warp.findOpenIssueRuns = async () => [makeRun({
      pendingAct: { id: 'act-1', name: ACTS.IMPLEMENT, opts: {} },
      parentEntityId: 'build-group-1',
      parentEntityLabel: 'Build',
    })];
    m.execute.implement = async () => ({
      type: 'success', costUsd: 0, trace: null, outcomeOpts: {}, nextActOpts: {},
    });
    const runner = createRunner({ ...m, board: null, log: m.log });

    await runner.poll();
    await runner.waitForInFlight();

    assert.equal(m.calls.filter(c => c.name === 'syncState').length, 0);
  });
});
