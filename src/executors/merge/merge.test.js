import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides = {}) {
  return {
    _issueId: 42,
    _prs: [{ repo: 'owner/repo', prNumber: 1 }],
    ...overrides,
  };
}

function makePRClient(overrides = {}) {
  const calls = [];
  const mergedPRs = new Set();
  return {
    getPRState: overrides.getPRState || ((prNumber) => mergedPRs.has(prNumber) ? 'MERGED' : 'OPEN'),
    mergePR: overrides.mergePR || ((prNumber, opts) => {
      calls.push({ name: 'mergePR', prNumber, opts });
      mergedPRs.add(prNumber);
    }),
    getPRFiles: overrides.getPRFiles || (() => [{ path: 'src/index.js', additions: 10, deletions: 2 }]),
    getPRCommits: overrides.getPRCommits || (() => [{ messageHeadline: 'fix: stuff' }]),
    _calls: calls,
  };
}

function makeNotifier(overrides = {}) {
  return {
    comment: overrides.comment || (() => {}),
  };
}

function makeContext(overrides = {}) {
  const logs = [];
  const prs = overrides.prs || makePRClient(overrides.prsOverrides);
  const notify = overrides.notify || makeNotifier(overrides.notifyOverrides);
  return {
    config: overrides.config || { repoNames: ['owner/repo'] },
    clients: { prs, notify, log: msg => logs.push(msg) },
    _logs: logs,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('merge executor', () => {

  it('no PRs → error', async () => {
    const ctx = makeContext();
    const result = await merge(makeItem({ _prs: [] }), ctx);

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('No PRs'));
    assert.deepEqual(result.prs, []);
  });

  it('single PR success → returns prDetails', async () => {
    const ctx = makeContext();
    const result = await merge(makeItem(), ctx);

    assert.equal(result.type, 'success');
    assert.equal(result.prs.length, 1);
    assert.equal(result.prs[0].prNumber, 1);
    assert.ok(result.prDetails, 'should include prDetails');
    assert.equal(result.prDetails.length, 1);
    assert.equal(result.prDetails[0].files.length, 1);
  });

  it('multiple PRs all merged → success', async () => {
    const ctx = makeContext();
    const item = makeItem({
      _prs: [
        { repo: 'owner/repo', prNumber: 1 },
        { repo: 'owner/repo', prNumber: 2 },
      ],
    });
    const result = await merge(item, ctx);

    assert.equal(result.type, 'success');
    assert.equal(result.prs.length, 2);
  });

  it('already-merged PR is skipped without error', async () => {
    const mergedByUs = new Set();
    const ctx = makeContext({
      prs: makePRClient({
        getPRState: (prNumber) => {
          if (prNumber === 1) return 'MERGED'; // pre-merged
          return mergedByUs.has(prNumber) ? 'MERGED' : 'OPEN';
        },
        mergePR: (prNumber) => { mergedByUs.add(prNumber); },
      }),
    });
    const item = makeItem({
      _prs: [
        { repo: 'owner/repo', prNumber: 1 },
        { repo: 'owner/repo', prNumber: 2 },
      ],
    });
    const result = await merge(item, ctx);

    assert.equal(result.type, 'success');
    assert.equal(result.prs.length, 2);
    // PR 1 should be in merged list (skipped as already merged)
    assert.ok(result.prs.some(p => p.prNumber === 1));
  });

  it('closed PR → error with state message', async () => {
    const ctx = makeContext({
      prs: makePRClient({
        getPRState: () => 'CLOSED',
      }),
    });
    const result = await merge(makeItem(), ctx);

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('closed'));
  });

  it('partial merge failure → tracks failedPrs', async () => {
    let callCount = 0;
    const ctx = makeContext({
      prs: makePRClient({
        mergePR: (prNumber) => {
          callCount++;
          if (prNumber === 2) throw new Error('merge conflict');
        },
        // After merge, getPRState is called to verify
        getPRState: (prNumber) => {
          if (prNumber === 1 && callCount >= 1) return 'MERGED';
          return 'OPEN';
        },
      }),
    });
    const item = makeItem({
      _prs: [
        { repo: 'owner/repo', prNumber: 1 },
        { repo: 'owner/repo', prNumber: 2 },
        { repo: 'owner/repo', prNumber: 3 },
      ],
    });
    const result = await merge(item, ctx);

    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('merge conflict'));
    // PR 1 was merged successfully
    assert.equal(result.prs.length, 1);
    assert.equal(result.prs[0].prNumber, 1);
    // PRs 2 and 3 are failed (2 failed, 3 never attempted)
    assert.ok(result.failedPrs, 'should track failedPrs');
    assert.equal(result.failedPrs.length, 2);
    assert.ok(result.failedPrs.some(p => p.prNumber === 2));
    assert.ok(result.failedPrs.some(p => p.prNumber === 3));
  });

  it('merge failure on first PR → all are failedPrs', async () => {
    const ctx = makeContext({
      prs: makePRClient({
        mergePR: () => { throw new Error('git error'); },
      }),
    });
    const item = makeItem({
      _prs: [
        { repo: 'owner/repo', prNumber: 1 },
        { repo: 'owner/repo', prNumber: 2 },
      ],
    });
    const result = await merge(item, ctx);

    assert.equal(result.type, 'error');
    assert.equal(result.prs.length, 0, 'no PRs merged');
    assert.equal(result.failedPrs.length, 2, 'all PRs failed');
  });

  it('post-merge summary comment failure is non-fatal', async () => {
    const mergedPRs = new Set();
    const ctx = makeContext({
      prs: makePRClient({
        getPRState: (prNumber) => mergedPRs.has(prNumber) ? 'MERGED' : 'OPEN',
        mergePR: (prNumber) => { mergedPRs.add(prNumber); },
      }),
      notify: makeNotifier({
        comment: () => { throw new Error('comment API down'); },
      }),
    });
    const result = await merge(makeItem(), ctx);

    assert.equal(result.type, 'success');
    assert.ok(ctx._logs.some(l => l.includes('failed to post')));
  });
});
