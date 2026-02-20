import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort, mergeDAGs, buildSteps, computeLevels, computeDeployBatch } from '../src/workflows/plan.js';

// ---------------------------------------------------------------------------
// topoSort
// ---------------------------------------------------------------------------

describe('topoSort', () => {
  it('returns [] for empty DAG', () => {
    assert.deepEqual(topoSort({}), []);
  });

  it('returns single node', () => {
    assert.deepEqual(topoSort({ A: [] }), ['A']);
  });

  it('returns linear chain in dependency order', () => {
    // A has no deps, B depends on A, C depends on B
    const result = topoSort({ A: [], B: ['A'], C: ['B'] });
    assert.deepEqual(result, ['A', 'B', 'C']);
  });

  it('handles diamond dependency', () => {
    // A no deps, B→A, C→A, D→[B,C]
    const result = topoSort({ A: [], B: ['A'], C: ['A'], D: ['B', 'C'] });
    assert.ok(result);
    assert.equal(result[0], 'A');
    assert.equal(result[result.length - 1], 'D');
    assert.ok(result.indexOf('B') < result.indexOf('D'));
    assert.ok(result.indexOf('C') < result.indexOf('D'));
  });

  it('handles parallel branches (independent subgraphs)', () => {
    const result = topoSort({ X: [], Y: [], Z: [] });
    assert.ok(result);
    assert.equal(result.length, 3);
    assert.ok(result.includes('X'));
    assert.ok(result.includes('Y'));
    assert.ok(result.includes('Z'));
  });

  it('returns null on cycle', () => {
    const result = topoSort({ A: ['B'], B: ['A'] });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// mergeDAGs
// ---------------------------------------------------------------------------

describe('mergeDAGs', () => {
  it('merges non-overlapping plans', () => {
    const plans = [
      { issue: { opts: { issue: '1' } }, releaseSteps: [{ repo: 'org/a' }], releaseDAG: { 'org/a': [] } },
      { issue: { opts: { issue: '2' } }, releaseSteps: [{ repo: 'org/b' }], releaseDAG: { 'org/b': [] } },
    ];
    const merged = mergeDAGs(plans);
    assert.ok(merged.steps.has('org/a'));
    assert.ok(merged.steps.has('org/b'));
    assert.deepEqual(merged.dag['org/a'], []);
    assert.deepEqual(merged.dag['org/b'], []);
  });

  it('deduplicates overlapping repos', () => {
    const plans = [
      { issue: { opts: { issue: '1' } }, releaseSteps: [{ repo: 'org/api', script: 'npm run deploy:prod' }], releaseDAG: { 'org/api': [] } },
      { issue: { opts: { issue: '2' } }, releaseSteps: [{ repo: 'org/api', script: 'npm run deploy:prod' }], releaseDAG: { 'org/api': [] } },
    ];
    const merged = mergeDAGs(plans);
    assert.equal(merged.steps.size, 1);
    const issues = [...merged.issuesByRepo.get('org/api')];
    assert.ok(issues.includes('1'));
    assert.ok(issues.includes('2'));
  });

  it('merges DAG edges as union', () => {
    const plans = [
      { issue: { opts: { issue: '1' } }, releaseSteps: [{ repo: 'org/a' }, { repo: 'org/b' }], releaseDAG: { 'org/a': [], 'org/b': ['org/a'] } },
      { issue: { opts: { issue: '2' } }, releaseSteps: [{ repo: 'org/a' }, { repo: 'org/c' }], releaseDAG: { 'org/a': [], 'org/c': ['org/a'] } },
    ];
    const merged = mergeDAGs(plans);
    assert.deepEqual(merged.dag['org/b'], ['org/a']);
    assert.deepEqual(merged.dag['org/c'], ['org/a']);
    assert.deepEqual(merged.dag['org/a'], []);
  });
});

// ---------------------------------------------------------------------------
// computeLevels
// ---------------------------------------------------------------------------

describe('computeLevels', () => {
  it('assigns linear levels', () => {
    const ordered = ['A', 'B', 'C'];
    const dag = { A: [], B: ['A'], C: ['B'] };
    const levels = computeLevels(ordered, dag);
    assert.equal(levels.get('A'), 0);
    assert.equal(levels.get('B'), 1);
    assert.equal(levels.get('C'), 2);
  });

  it('assigns same level to parallel nodes', () => {
    const ordered = ['A', 'B'];
    const dag = { A: [], B: [] };
    const levels = computeLevels(ordered, dag);
    assert.equal(levels.get('A'), 0);
    assert.equal(levels.get('B'), 0);
  });

  it('handles diamond correctly', () => {
    const ordered = ['A', 'B', 'C', 'D'];
    const dag = { A: [], B: ['A'], C: ['A'], D: ['B', 'C'] };
    const levels = computeLevels(ordered, dag);
    assert.equal(levels.get('A'), 0);
    assert.equal(levels.get('B'), 1);
    assert.equal(levels.get('C'), 1);
    assert.equal(levels.get('D'), 2);
  });
});

// ---------------------------------------------------------------------------
// buildSteps
// ---------------------------------------------------------------------------

describe('buildSteps', () => {
  it('produces correct shape', () => {
    const ordered = ['org/warp', 'org/api'];
    const merged = {
      steps: new Map([
        ['org/warp', { script: 'npm run release:patch' }],
        ['org/api', { script: 'npm run deploy:prod' }],
      ]),
      dag: { 'org/warp': [], 'org/api': ['org/warp'] },
      issuesByRepo: new Map([
        ['org/warp', new Set(['1'])],
        ['org/api', new Set(['1', '2'])],
      ]),
    };

    const steps = buildSteps(ordered, merged);
    assert.equal(steps.length, 2);

    assert.equal(steps[0].repo, 'org/warp');
    assert.equal(steps[0].level, 0);
    assert.deepEqual(steps[0].dependsOn, []);
    assert.deepEqual(steps[0].issues, ['1']);

    assert.equal(steps[1].repo, 'org/api');
    assert.equal(steps[1].level, 1);
    assert.deepEqual(steps[1].dependsOn, ['org/warp']);
    assert.ok(steps[1].issues.includes('1'));
    assert.ok(steps[1].issues.includes('2'));
  });

  it('groups parallel repos at same level', () => {
    const ordered = ['org/a', 'org/b'];
    const merged = {
      steps: new Map([
        ['org/a', { script: 'npm run release:patch' }],
        ['org/b', { script: 'npm run release:patch' }],
      ]),
      dag: { 'org/a': [], 'org/b': [] },
      issuesByRepo: new Map([
        ['org/a', new Set(['1'])],
        ['org/b', new Set(['2'])],
      ]),
    };

    const steps = buildSteps(ordered, merged);
    assert.equal(steps[0].level, 0);
    assert.equal(steps[1].level, 0);
  });
});

// ---------------------------------------------------------------------------
// computeDeployBatch
// ---------------------------------------------------------------------------

describe('computeDeployBatch', () => {
  it('single issue, no overlap → batch of 1', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], releaseSteps: [{ repo: 'org/api' }], releaseDAG: {} },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], releaseSteps: [{ repo: 'org/frontend' }], releaseDAG: {} },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds, [1]);
    assert.equal(batch.issues.length, 1);
  });

  it('two issues sharing a repo → both in batch', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], releaseSteps: [{ repo: 'org/api' }], releaseDAG: {} },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], releaseSteps: [{ repo: 'org/api' }], releaseDAG: {} },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds.sort(), [1, 2]);
    assert.equal(batch.issues.length, 2);
  });

  it('transitive: A shares repo with B, B has another repo shared with C → all three', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], releaseSteps: [{ repo: 'org/api' }], releaseDAG: {} },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], releaseSteps: [{ repo: 'org/api' }, { repo: 'org/frontend' }], releaseDAG: {} },
      { issueId: 3, runId: 'r3', parentEntityId: 'g3', prs: [], releaseSteps: [{ repo: 'org/frontend' }], releaseDAG: {} },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds.sort(), [1, 2, 3]);
  });

  it('no overlap → batch of 1 (trigger only)', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], releaseSteps: [{ repo: 'org/api' }], releaseDAG: {} },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], releaseSteps: [{ repo: 'org/warp' }], releaseDAG: {} },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds, [1]);
  });

  it('trigger issue not found → returns null', () => {
    const awaiting = [
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], releaseSteps: [{ repo: 'org/api' }], releaseDAG: {} },
    ];
    const batch = computeDeployBatch(99, awaiting);
    assert.equal(batch, null);
  });
});
