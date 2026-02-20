import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deploy } from '../src/executors/deploy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActOpts({ release = [], ...rest } = {}) {
  return { prs: [], release, ...rest };
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
      release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }],
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

    // Should have run the command
    const cmdCall = exec._calls.find(c => c.cmd === 'npm run deploy:prod');
    assert.ok(cmdCall, 'should run deploy command');
  });

  it('multiple steps in DAG order — clones once per repo, runs in level order', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      release: [
        { repo: 'org/warp', command: 'npm run release:patch', dependsOn: [] },
        { repo: 'org/api', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
        { repo: 'org/frontend', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
      ],
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
      release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }],
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
      release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }],
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

  it('partial failure returns completedRepos', async () => {
    const logs = [];
    const codehost = makeCodehost();
    // warp succeeds (level 0), frontend fails (level 1)
    const exec = makeExec((cmd) => {
      if (cmd === 'npm run deploy:prod') throw new Error('build failed');
    });
    const fs = makeFsMock();

    const actOpts = makeActOpts({
      release: [
        { repo: 'org/warp', command: 'npm run release:patch', dependsOn: [] },
        { repo: 'org/frontend', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
      ],
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'error');
    assert.ok(result.completedRepos instanceof Set);
    assert.ok(result.completedRepos.has('org/warp'), 'warp should be in completedRepos');
    assert.ok(!result.completedRepos.has('org/frontend'), 'frontend should NOT be in completedRepos');
  });

  it('no release steps returns error', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const actOpts = makeActOpts({ release: [] });

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
      release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }],
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
      release: [
        { repo: 'org/a', command: 'npm run deploy:prod', dependsOn: ['org/b'] },
        { repo: 'org/b', command: 'npm run deploy:prod', dependsOn: ['org/a'] },
      ],
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
        release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }],
      },
      {
        issueId: 99, runId: 'r2',
        release: [
          { repo: 'org/warp', command: 'npm run release:patch', dependsOn: [] },
          { repo: 'org/api', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
        ],
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

  it('repos with same basename get unique directories', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      release: [
        { repo: 'org-a/api', command: 'npm run deploy:prod', dependsOn: [] },
        { repo: 'org-b/api', command: 'npm run deploy:prod', dependsOn: [] },
      ],
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'success');
    assert.equal(codehost._cloneCalls.length, 2);

    // Destinations must be different (deriveRepoDirNames handles collision)
    const dests = codehost._cloneCalls.map(c => c.dest);
    assert.notEqual(dests[0], dests[1], 'clone destinations should be unique');
  });

  it('workdir uses unique UUID suffix', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }],
    });

    // Run twice and verify workdirs differ
    const result1 = await deploy(actOpts, { codehost, deployBatch: null, exec, fs, log: msg => logs.push(msg) });
    const result2 = await deploy(actOpts, { codehost, deployBatch: null, exec, fs, log: msg => logs.push(msg) });

    assert.equal(result1.type, 'success');
    assert.equal(result2.type, 'success');

    // The mkdirSync calls should have different paths (due to UUID)
    const mkdirCalls = fs._calls.filter(c => c.name === 'mkdirSync');
    assert.ok(mkdirCalls.length >= 2, 'should have at least 2 mkdirSync calls');
    const paths = mkdirCalls.map(c => c.args[0]);
    assert.ok(paths[0].includes('deploy-'), 'workdir should include deploy- prefix');
    assert.notEqual(paths[0], paths[paths.length - 1], 'concurrent deploys should use different workdirs');
  });

  it('step without script is skipped', async () => {
    const logs = [];
    const codehost = makeCodehost();
    const exec = makeExec();
    const fs = makeFsMock();
    const actOpts = makeActOpts({
      release: [{ repo: 'org/lib', command: null, dependsOn: [] }],
    });

    const result = await deploy(actOpts, {
      codehost, deployBatch: null, exec, fs,
      log: msg => logs.push(msg),
    });

    assert.equal(result.type, 'success');
    assert.equal(exec._calls.length, 0, 'should not run any scripts');
    assert.ok(logs.some(l => l.includes('no command')));
  });
});
