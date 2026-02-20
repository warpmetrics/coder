import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deploy } from '../src/executors/deploy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActOpts({ releaseSteps = [], releaseDAG = {}, ...rest } = {}) {
  return { issueId: 42, prs: [], releaseSteps, releaseDAG, ...rest };
}

function makeBatch(issues) {
  return {
    issueIds: issues.map(i => i.issueId),
    issues,
  };
}

function makeCodehost({ cloneFn } = {}) {
  const cloneCalls = [];
  return {
    clone(url, dest) {
      cloneCalls.push({ url, dest });
      if (cloneFn) cloneFn(url, dest);
    },
    _cloneCalls: cloneCalls,
  };
}

function makeExec(impl) {
  const calls = [];
  const fn = (cmd, opts) => {
    calls.push({ cmd, opts });
    if (impl) return impl(cmd, opts);
    return '';
  };
  fn._calls = calls;
  return fn;
}

function makeFsMock() {
  const calls = [];
  return {
    existsSync: () => false,
    rmSync: (...args) => { calls.push({ name: 'rmSync', args }); },
    mkdirSync: (...args) => { calls.push({ name: 'mkdirSync', args }); },
    _calls: calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deploy executor', () => {

  it('single step, success', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      releaseSteps: [{ repo: 'org/api', type: 'service', script: 'npm run deploy:prod' }],
      releaseDAG: { 'org/api': [] },
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'success');
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].repo, 'org/api');

    // Should have cloned the repo
    assert.equal(codehost._cloneCalls.length, 1);
    assert.ok(codehost._cloneCalls[0].url.includes('org/api'));

    // Should have run the script
    const scriptCall = exec._calls.find(c => c.cmd === 'npm run deploy:prod');
    assert.ok(scriptCall, 'should run deploy script');
  });

  it('multiple steps in DAG order — clones once per repo, runs in level order', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      releaseSteps: [
        { repo: 'org/warp', type: 'package', script: 'npm run release:patch' },
        { repo: 'org/api', type: 'service', script: 'npm run deploy:prod' },
        { repo: 'org/frontend', type: 'service', script: 'npm run deploy:prod' },
      ],
      releaseDAG: {
        'org/warp': [],
        'org/api': ['org/warp'],
        'org/frontend': ['org/warp'],
      },
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'success');
    assert.equal(result.steps.length, 3);

    // Clone once per repo
    assert.equal(codehost._cloneCalls.length, 3);

    // warp should be level 0, api and frontend level 1
    const warpStep = result.steps.find(s => s.repo === 'org/warp');
    const apiStep = result.steps.find(s => s.repo === 'org/api');
    const frontendStep = result.steps.find(s => s.repo === 'org/frontend');
    assert.equal(warpStep.level, 0);
    assert.equal(apiStep.level, 1);
    assert.equal(frontendStep.level, 1);

    // Script execution order: warp first, then api + frontend
    const scriptCmds = exec._calls.map(c => c.cmd);
    const warpIdx = scriptCmds.indexOf('npm run release:patch');
    const apiIdx = scriptCmds.findIndex(c => c === 'npm run deploy:prod');
    assert.ok(warpIdx < apiIdx, 'warp should run before api/frontend');
  });

  it('clone failure returns error and cleans up', async () => {
    const logs = [];
    const codehost = makeCodehost({
      cloneFn: () => { throw new Error('git clone failed'); },
    });
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      releaseSteps: [{ repo: 'org/api', type: 'service', script: 'npm run deploy:prod' }],
      releaseDAG: { 'org/api': [] },
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('Clone failed'));
    assert.ok(result.error.includes('org/api'));

    // Should have called rmSync for cleanup
    const rmCalls = fs._calls.filter(c => c.name === 'rmSync');
    assert.ok(rmCalls.length >= 1, 'should clean up after failure');
  });

  it('script failure returns error and cleans up', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec(() => { throw new Error('deploy script failed'); });
    const fs = makeFsMock();

    const actOpts = makeActOpts({
      releaseSteps: [{ repo: 'org/api', type: 'service', script: 'npm run deploy:prod' }],
      releaseDAG: { 'org/api': [] },
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('Deploy failed'));

    const rmCalls = fs._calls.filter(c => c.name === 'rmSync');
    assert.ok(rmCalls.length >= 1, 'should clean up after failure');
  });

  it('no release steps returns error', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const actOpts = makeActOpts({ releaseSteps: [], releaseDAG: {} });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec: makeExec(), fs: makeFsMock(),
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('No deploy steps'));
  });

  it('empty batch uses single issue steps', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      releaseSteps: [{ repo: 'org/api', type: 'service', script: 'npm run deploy:prod' }],
      releaseDAG: { 'org/api': [] },
    });

    // deployBatch with empty issues array
    const result = await deploy(actOpts, {
      codehost, deployBatch: { issueIds: [], issues: [] }, exec, fs,
      log: msg => logs.push(msg),
    });

    // Should fall back to actOpts since batch is empty
    assert.equal(result.type, 'success');
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].repo, 'org/api');
  });

  it('circular DAG returns error', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const actOpts = makeActOpts({
      releaseSteps: [
        { repo: 'org/a', type: 'service', script: 'npm run deploy:prod' },
        { repo: 'org/b', type: 'service', script: 'npm run deploy:prod' },
      ],
      releaseDAG: {
        'org/a': ['org/b'],
        'org/b': ['org/a'],
      },
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec: makeExec(), fs: makeFsMock(),
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('Circular dependency'));
  });

  it('batch merges DAGs from multiple issues', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();

    const batch = makeBatch([
      {
        issueId: 42, runId: 'r1',
        releaseSteps: [{ repo: 'org/api', type: 'service', script: 'npm run deploy:prod' }],
        releaseDAG: { 'org/api': [] },
      },
      {
        issueId: 99, runId: 'r2',
        releaseSteps: [
          { repo: 'org/warp', type: 'package', script: 'npm run release:patch' },
          { repo: 'org/api', type: 'service', script: 'npm run deploy:prod' },
        ],
        releaseDAG: { 'org/warp': [], 'org/api': ['org/warp'] },
      },
    ]);

    const result = await deploy({ issueId: 42 }, {
      codehost, deployBatch: batch, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'success');
    // Should have merged: warp + api (api deduped)
    assert.equal(result.steps.length, 2);
    const repos = result.steps.map(s => s.repo).sort();
    assert.deepEqual(repos, ['org/api', 'org/warp']);

    // warp at level 0, api at level 1
    const warpStep = result.steps.find(s => s.repo === 'org/warp');
    const apiStep = result.steps.find(s => s.repo === 'org/api');
    assert.equal(warpStep.level, 0);
    assert.equal(apiStep.level, 1);
  });

  it('step without script is skipped', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      releaseSteps: [{ repo: 'org/lib', type: 'unknown', script: null }],
      releaseDAG: { 'org/lib': [] },
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'success');
    assert.equal(exec._calls.length, 0, 'should not run any scripts');
    assert.ok(logs.some(l => l.includes('no script')));
  });
});
