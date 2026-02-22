import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort, mergeDAGs, buildSteps, computeLevels, computeDeployBatch } from './plan.js';
import { validateDeployPlan, extractJsonArray, buildDeployPlan } from './release.js';

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
      { issue: { opts: { issue: '1' } }, release: [{ repo: 'org/a', command: 'npm run deploy:prod', dependsOn: [] }] },
      { issue: { opts: { issue: '2' } }, release: [{ repo: 'org/b', command: 'npm run deploy:prod', dependsOn: [] }] },
    ];
    const merged = mergeDAGs(plans);
    assert.ok(merged.steps.has('org/a'));
    assert.ok(merged.steps.has('org/b'));
    assert.deepEqual(merged.dag['org/a'], []);
    assert.deepEqual(merged.dag['org/b'], []);
  });

  it('deduplicates overlapping repos', () => {
    const plans = [
      { issue: { opts: { issue: '1' } }, release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }] },
      { issue: { opts: { issue: '2' } }, release: [{ repo: 'org/api', command: 'npm run deploy:prod', dependsOn: [] }] },
    ];
    const merged = mergeDAGs(plans);
    assert.equal(merged.steps.size, 1);
    const issues = [...merged.issuesByRepo.get('org/api')];
    assert.ok(issues.includes('1'));
    assert.ok(issues.includes('2'));
  });

  it('merges DAG edges as union', () => {
    const plans = [
      { issue: { opts: { issue: '1' } }, release: [{ repo: 'org/a', command: 'x', dependsOn: [] }, { repo: 'org/b', command: 'x', dependsOn: ['org/a'] }] },
      { issue: { opts: { issue: '2' } }, release: [{ repo: 'org/a', command: 'x', dependsOn: [] }, { repo: 'org/c', command: 'x', dependsOn: ['org/a'] }] },
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
        ['org/warp', { command: 'npm run release:patch' }],
        ['org/api', { command: 'npm run deploy:prod' }],
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
    assert.equal(steps[0].command, 'npm run release:patch');
    assert.equal(steps[0].level, 0);
    assert.deepEqual(steps[0].dependsOn, []);
    assert.deepEqual(steps[0].issues, ['1']);

    assert.equal(steps[1].repo, 'org/api');
    assert.equal(steps[1].command, 'npm run deploy:prod');
    assert.equal(steps[1].level, 1);
    assert.deepEqual(steps[1].dependsOn, ['org/warp']);
    assert.ok(steps[1].issues.includes('1'));
    assert.ok(steps[1].issues.includes('2'));
  });

  it('groups parallel repos at same level', () => {
    const ordered = ['org/a', 'org/b'];
    const merged = {
      steps: new Map([
        ['org/a', { command: 'npm run release:patch' }],
        ['org/b', { command: 'npm run release:patch' }],
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
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], release: [{ repo: 'org/api' }] },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], release: [{ repo: 'org/frontend' }] },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds, [1]);
    assert.equal(batch.issues.length, 1);
  });

  it('two issues sharing a repo → both in batch', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], release: [{ repo: 'org/api' }] },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], release: [{ repo: 'org/api' }] },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds.sort(), [1, 2]);
    assert.equal(batch.issues.length, 2);
  });

  it('transitive: A shares repo with B, B has another repo shared with C → all three', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], release: [{ repo: 'org/api' }] },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], release: [{ repo: 'org/api' }, { repo: 'org/frontend' }] },
      { issueId: 3, runId: 'r3', parentEntityId: 'g3', prs: [], release: [{ repo: 'org/frontend' }] },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds.sort(), [1, 2, 3]);
  });

  it('no overlap → batch of 1 (trigger only)', () => {
    const awaiting = [
      { issueId: 1, runId: 'r1', parentEntityId: 'g1', prs: [], release: [{ repo: 'org/api' }] },
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], release: [{ repo: 'org/warp' }] },
    ];
    const batch = computeDeployBatch(1, awaiting);
    assert.ok(batch);
    assert.deepEqual(batch.issueIds, [1]);
  });

  it('terminates on large input (no infinite loop)', () => {
    // Create a large set of overlapping issues to exercise the iteration cap
    const awaiting = [];
    for (let i = 0; i < 50; i++) {
      awaiting.push({
        issueId: i, runId: `r${i}`, parentEntityId: `g${i}`, prs: [],
        // Every issue shares 'org/shared' so all will be batched transitively
        release: [{ repo: 'org/shared' }, { repo: `org/repo-${i}` }],
      });
    }
    const batch = computeDeployBatch(0, awaiting);
    assert.ok(batch);
    assert.equal(batch.issueIds.length, 50, 'all 50 overlapping issues should be batched');
  });

  it('trigger issue not found → returns null', () => {
    const awaiting = [
      { issueId: 2, runId: 'r2', parentEntityId: 'g2', prs: [], release: [{ repo: 'org/api' }] },
    ];
    const batch = computeDeployBatch(99, awaiting);
    assert.equal(batch, null);
  });
});

// ---------------------------------------------------------------------------
// buildDeployPlan
// ---------------------------------------------------------------------------

describe('buildDeployPlan', () => {
  const deployConfig = {
    'warpmetrics/frontend': { command: 'npm run deploy:prod' },
    'warpmetrics/api': { command: 'npm run deploy:prod' },
    'warpmetrics/warp': { command: 'npm run release:patch' },
  };

  it('single repo from PRs', () => {
    const prs = [{ repo: 'warpmetrics/frontend' }];
    const result = buildDeployPlan(prs, deployConfig);
    assert.ok(result);
    assert.equal(result.release.length, 1);
    assert.equal(result.release[0].repo, 'warpmetrics/frontend');
    assert.equal(result.release[0].command, 'npm run deploy:prod');
    assert.deepEqual(result.release[0].dependsOn, []);
  });

  it('multi-repo with dependencies', () => {
    const prs = [{ repo: 'warpmetrics/warp' }, { repo: 'warpmetrics/api' }];
    const deps = [
      { repo: 'warpmetrics/warp', dependsOn: [] },
      { repo: 'warpmetrics/api', dependsOn: ['warpmetrics/warp'] },
    ];
    const result = buildDeployPlan(prs, deployConfig, deps);
    assert.ok(result);
    assert.equal(result.release.length, 2);
    assert.deepEqual(result.release[1].dependsOn, ['warpmetrics/warp']);
  });

  it('skips repos without deploy config', () => {
    const prs = [{ repo: 'warpmetrics/frontend' }, { repo: 'unknown/repo' }];
    const result = buildDeployPlan(prs, deployConfig);
    assert.ok(result);
    assert.equal(result.release.length, 1);
    assert.equal(result.release[0].repo, 'warpmetrics/frontend');
  });

  it('deduplicates repos from multiple PRs', () => {
    const prs = [{ repo: 'warpmetrics/api' }, { repo: 'warpmetrics/api' }];
    const result = buildDeployPlan(prs, deployConfig);
    assert.ok(result);
    assert.equal(result.release.length, 1);
  });

  it('returns null for no PRs', () => {
    assert.equal(buildDeployPlan([], deployConfig), null);
    assert.equal(buildDeployPlan(null, deployConfig), null);
  });

  it('returns null for no deploy config', () => {
    assert.equal(buildDeployPlan([{ repo: 'warpmetrics/api' }], null), null);
  });

  it('returns null when no repos match config', () => {
    const prs = [{ repo: 'unknown/repo' }];
    assert.equal(buildDeployPlan(prs, deployConfig), null);
  });
});

// ---------------------------------------------------------------------------
// validateDeployPlan
// ---------------------------------------------------------------------------

describe('validateDeployPlan', () => {
  it('single repo with empty dependsOn', () => {
    const result = validateDeployPlan([
      { repo: 'org/frontend', command: 'npm run deploy:prod', dependsOn: [] },
    ]);
    assert.ok(result);
    assert.equal(result.release.length, 1);
    assert.equal(result.release[0].repo, 'org/frontend');
    assert.equal(result.release[0].command, 'npm run deploy:prod');
    assert.deepEqual(result.release[0].dependsOn, []);
  });

  it('nested dependsOn with values', () => {
    const result = validateDeployPlan([
      { repo: 'org/warp', command: 'npm run release:patch', dependsOn: [] },
      { repo: 'org/api', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
    ]);
    assert.ok(result);
    assert.equal(result.release.length, 2);
    assert.deepEqual(result.release[1].dependsOn, ['org/warp']);
  });

  it('diamond dependency', () => {
    const result = validateDeployPlan([
      { repo: 'org/warp', command: 'npm run release:patch', dependsOn: [] },
      { repo: 'org/api', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
      { repo: 'org/frontend', command: 'npm run deploy:prod', dependsOn: ['org/warp'] },
      { repo: 'org/infra', command: './wm deploy prod', dependsOn: ['org/api', 'org/frontend'] },
    ]);
    assert.ok(result);
    assert.equal(result.release.length, 4);
    assert.deepEqual(result.release[3].dependsOn, ['org/api', 'org/frontend']);
  });

  it('returns null for non-array', () => {
    assert.equal(validateDeployPlan('not an array'), null);
    assert.equal(validateDeployPlan(null), null);
    assert.equal(validateDeployPlan({}), null);
  });

  it('returns null for empty array', () => {
    assert.equal(validateDeployPlan([]), null);
  });

  it('returns null for missing repo', () => {
    assert.equal(validateDeployPlan([{ command: 'npm run deploy:prod' }]), null);
  });

  it('returns null for missing command', () => {
    assert.equal(validateDeployPlan([{ repo: 'org/api' }]), null);
  });

  it('defaults dependsOn to empty array when missing', () => {
    const result = validateDeployPlan([{ repo: 'org/api', command: 'npm run deploy:prod' }]);
    assert.ok(result);
    assert.deepEqual(result.release[0].dependsOn, []);
  });
});

// ---------------------------------------------------------------------------
// extractJsonArray
// ---------------------------------------------------------------------------

describe('extractJsonArray', () => {
  it('parses clean JSON array', () => {
    const result = extractJsonArray('[{"repo":"org/api","command":"npm run deploy:prod","dependsOn":[]}]');
    assert.ok(Array.isArray(result));
    assert.equal(result[0].repo, 'org/api');
  });

  it('extracts from markdown code fence', () => {
    const text = 'Here is the plan:\n\n```json\n[{"repo":"org/api","command":"npm run deploy:prod","dependsOn":[]}]\n```';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].repo, 'org/api');
  });

  it('extracts from plain code fence', () => {
    const text = '```\n[{"repo":"org/api","command":"npm run deploy:prod","dependsOn":[]}]\n```';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].repo, 'org/api');
  });

  it('extracts JSON embedded in surrounding text', () => {
    const text = 'The deployment plan is:\n[{"repo":"org/api","command":"npm run deploy:prod","dependsOn":[]}]\nDone.';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].repo, 'org/api');
  });

  it('handles nested brackets in dependsOn', () => {
    const text = '[{"repo":"org/api","command":"npm run deploy:prod","dependsOn":["org/warp"]}]';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result));
    assert.deepEqual(result[0].dependsOn, ['org/warp']);
  });

  it('returns null for null/empty input', () => {
    assert.equal(extractJsonArray(null), null);
    assert.equal(extractJsonArray(''), null);
  });

  it('returns null for text without JSON array', () => {
    assert.equal(extractJsonArray('No JSON here'), null);
  });
});
