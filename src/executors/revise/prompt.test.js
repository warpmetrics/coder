import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRevisePrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// buildRevisePrompt
// ---------------------------------------------------------------------------

describe('buildRevisePrompt', () => {

  it('lists repo directories with PRs', () => {
    const prompt = buildRevisePrompt({
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 5 }],
      contextRepos: [],
      memory: '',
      reviewSection: 'Please fix the bug',
    });
    assert.ok(prompt.includes('api'));
    assert.ok(prompt.includes('PR #5'));
  });

  it('includes context repos for reference', () => {
    const prompt = buildRevisePrompt({
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 5 }],
      contextRepos: [{ url: 'https://github.com/org/warp.git', name: 'org/warp', dirName: 'warp' }],
      memory: '',
      reviewSection: 'Fix it',
    });
    assert.ok(prompt.includes('Other repos available'));
    assert.ok(prompt.includes('org/warp.git'));
  });

  it('includes review section', () => {
    const prompt = buildRevisePrompt({
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 5 }],
      contextRepos: [],
      memory: '',
      reviewSection: 'The error handling needs improvement',
    });
    assert.ok(prompt.includes('error handling needs improvement'));
  });

  it('handles empty review section', () => {
    const prompt = buildRevisePrompt({
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 5 }],
      contextRepos: [],
      memory: '',
      reviewSection: '',
    });
    assert.ok(prompt.includes('could be fetched'));
  });

  it('includes memory', () => {
    const prompt = buildRevisePrompt({
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 5 }],
      contextRepos: [],
      memory: 'Use strict mode always',
      reviewSection: 'Fix bugs',
    });
    assert.ok(prompt.includes('Use strict mode always'));
  });

  it('multi-repo commit instruction', () => {
    const prompt = buildRevisePrompt({
      repoDirs: [
        { dirName: 'api', name: 'org/api', prNumber: 5 },
        { dirName: 'frontend', name: 'org/frontend', prNumber: 6 },
      ],
      contextRepos: [],
      memory: '',
      reviewSection: 'Fix',
    });
    assert.ok(prompt.includes('Commit separately'));
  });
});
