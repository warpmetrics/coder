import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntentPrompt,
  buildImplementPrompt,
  buildRevisePrompt,
  buildReviewPrompt,
  buildReflectPrompt,
  IMPLEMENT_RESUME,
  PUBLIC_CHANGELOG,
  PRIVATE_CHANGELOG,
} from '../src/prompts.js';

// ---------------------------------------------------------------------------
// classifyIntentPrompt
// ---------------------------------------------------------------------------

describe('classifyIntentPrompt', () => {

  it('includes the message in the prompt', () => {
    const prompt = classifyIntentPrompt('Add a login button');
    assert.ok(prompt.includes('Add a login button'));
  });

  it('mentions PROPOSE and IMPLEMENT', () => {
    const prompt = classifyIntentPrompt('test');
    assert.ok(prompt.includes('PROPOSE'));
    assert.ok(prompt.includes('IMPLEMENT'));
  });
});

// ---------------------------------------------------------------------------
// buildImplementPrompt
// ---------------------------------------------------------------------------

describe('buildImplementPrompt', () => {
  const baseArgs = {
    workdir: '/tmp/warp-coder/42',
    repos: ['https://github.com/org/api.git'],
    repoNames: ['org/api'],
    dirNames: ['api'],
    primaryDirName: 'api',
    primaryRepoName: 'org/api',
    branch: 'agent/issue-42',
    issueId: 42,
    issueTitle: 'Fix login',
    issueBody: 'The login button is broken',
    memory: '',
    commentsText: '',
    shouldPropose: false,
  };

  it('includes workspace layout', () => {
    const prompt = buildImplementPrompt(baseArgs);
    assert.ok(prompt.includes('Workspace layout'));
    assert.ok(prompt.includes('/tmp/warp-coder/42'));
    assert.ok(prompt.includes('api'));
  });

  it('includes issue details', () => {
    const prompt = buildImplementPrompt(baseArgs);
    assert.ok(prompt.includes('#42'));
    assert.ok(prompt.includes('Fix login'));
    assert.ok(prompt.includes('login button is broken'));
  });

  it('includes memory when provided', () => {
    const prompt = buildImplementPrompt({ ...baseArgs, memory: 'Always run npm test' });
    assert.ok(prompt.includes('Lessons learned'));
    assert.ok(prompt.includes('Always run npm test'));
  });

  it('skips memory section when empty', () => {
    const prompt = buildImplementPrompt({ ...baseArgs, memory: '' });
    assert.ok(!prompt.includes('Lessons learned'));
  });

  it('includes comments when provided', () => {
    const prompt = buildImplementPrompt({ ...baseArgs, commentsText: 'alice: looks good' });
    assert.ok(prompt.includes('Discussion on the issue'));
    assert.ok(prompt.includes('alice: looks good'));
  });

  it('skips comments section when empty', () => {
    const prompt = buildImplementPrompt({ ...baseArgs, commentsText: '' });
    assert.ok(!prompt.includes('Discussion on the issue'));
  });

  it('sets propose mode instructions', () => {
    const prompt = buildImplementPrompt({ ...baseArgs, shouldPropose: true });
    assert.ok(prompt.includes('DO NOT make code changes'));
    assert.ok(prompt.includes('proposal'));
  });

  it('sets implement mode instructions', () => {
    const prompt = buildImplementPrompt({ ...baseArgs, shouldPropose: false });
    assert.ok(prompt.includes('Implement the changes'));
    assert.ok(prompt.includes('Commit all changes'));
  });

  it('handles multi-repo layout', () => {
    const prompt = buildImplementPrompt({
      ...baseArgs,
      repos: ['https://github.com/org/api.git', 'https://github.com/org/frontend.git'],
      repoNames: ['org/api', 'org/frontend'],
      dirNames: ['api', 'frontend'],
    });
    assert.ok(prompt.includes('frontend'));
    assert.ok(prompt.includes('clone'));
    assert.ok(prompt.includes('SEPARATE git repositories'));
  });

  it('includes efficiency section', () => {
    const prompt = buildImplementPrompt(baseArgs);
    assert.ok(prompt.includes('Efficiency'));
    assert.ok(prompt.includes('subagents'));
  });
});

// ---------------------------------------------------------------------------
// IMPLEMENT_RESUME
// ---------------------------------------------------------------------------

describe('IMPLEMENT_RESUME', () => {

  it('is a non-empty string', () => {
    assert.ok(typeof IMPLEMENT_RESUME === 'string');
    assert.ok(IMPLEMENT_RESUME.length > 0);
  });

  it('mentions continuation', () => {
    assert.ok(IMPLEMENT_RESUME.includes('Continue'));
  });
});

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

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

describe('buildReviewPrompt', () => {

  it('includes workspace layout with repos', () => {
    const prompt = buildReviewPrompt({
      workdir: '/tmp/review-42',
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 1 }],
      diffs: [],
      issueId: 42,
      issueTitle: 'Fix bug',
      issueBody: '',
      commentsText: '',
    });
    assert.ok(prompt.includes('/tmp/review-42'));
    assert.ok(prompt.includes('api'));
    assert.ok(prompt.includes('PR #1'));
  });

  it('includes issue context', () => {
    const prompt = buildReviewPrompt({
      workdir: '/tmp/review-42',
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 1 }],
      diffs: [],
      issueId: 42,
      issueTitle: 'Fix login',
      issueBody: 'Login is broken on Safari',
      commentsText: '',
    });
    assert.ok(prompt.includes('Fix login'));
    assert.ok(prompt.includes('Login is broken on Safari'));
  });

  it('includes diffs', () => {
    const prompt = buildReviewPrompt({
      workdir: '/tmp/review-42',
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 1 }],
      diffs: [{ repo: 'org/api', prNumber: 1, diff: '+const x = 1;' }],
      issueId: 42,
      issueTitle: 'Fix bug',
      issueBody: '',
      commentsText: '',
    });
    assert.ok(prompt.includes('+const x = 1;'));
    assert.ok(prompt.includes('```diff'));
  });

  it('includes review instructions', () => {
    const prompt = buildReviewPrompt({
      workdir: '/tmp/review-42',
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 1 }],
      diffs: [],
      issueId: 42,
      issueTitle: 'Fix bug',
      issueBody: '',
      commentsText: '',
    });
    assert.ok(prompt.includes('Correctness'));
    assert.ok(prompt.includes('Security'));
    assert.ok(prompt.includes('.warp-coder-review'));
    assert.ok(prompt.includes('"verdict"'));
  });
});

// ---------------------------------------------------------------------------
// buildReflectPrompt
// ---------------------------------------------------------------------------

describe('buildReflectPrompt', () => {

  it('includes step and outcome', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
    });
    assert.ok(prompt.includes('Step: implement'));
    assert.ok(prompt.includes('Outcome: success'));
  });

  it('includes failure outcome', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'revise', success: false, error: 'timeout', maxLines: 100,
    });
    assert.ok(prompt.includes('Outcome: failure'));
    assert.ok(prompt.includes('timeout'));
  });

  it('includes issue info', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
      issue: { number: 42, title: 'Fix login' },
    });
    assert.ok(prompt.includes('#42'));
    assert.ok(prompt.includes('Fix login'));
  });

  it('includes PR number', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'revise', success: true, maxLines: 100, prNumber: 7,
    });
    assert.ok(prompt.includes('PR: #7'));
  });

  it('includes hook outputs', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
      hookOutputs: [{ hook: 'onBeforePush', exitCode: 0, stdout: 'lint ok', stderr: '' }],
    });
    assert.ok(prompt.includes('Hook outputs'));
    assert.ok(prompt.includes('onBeforePush'));
    assert.ok(prompt.includes('lint ok'));
  });

  it('includes review comments', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'revise', success: true, maxLines: 100,
      reviewComments: [{ user: { login: 'alice' }, body: 'Fix the return type' }],
    });
    assert.ok(prompt.includes('alice'));
    assert.ok(prompt.includes('Fix the return type'));
  });

  it('includes claude output', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
      claudeOutput: 'I fixed the bug by adding null check',
    });
    assert.ok(prompt.includes('Claude output'));
    assert.ok(prompt.includes('null check'));
  });

  it('includes current memory', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '## Testing\n- Always run jest', step: 'implement', success: true, maxLines: 100,
    });
    assert.ok(prompt.includes('Always run jest'));
  });

  it('uses maxLines limit', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 50,
    });
    assert.ok(prompt.includes('50 lines'));
  });

  it('handles no current memory', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
    });
    assert.ok(prompt.includes('no memory yet'));
  });
});

// ---------------------------------------------------------------------------
// Changelog prompts
// ---------------------------------------------------------------------------

describe('changelog prompts', () => {

  it('PUBLIC_CHANGELOG is non-empty', () => {
    assert.ok(typeof PUBLIC_CHANGELOG === 'string');
    assert.ok(PUBLIC_CHANGELOG.length > 50);
    assert.ok(PUBLIC_CHANGELOG.includes('public'));
    assert.ok(PUBLIC_CHANGELOG.includes('JSON'));
  });

  it('PRIVATE_CHANGELOG is non-empty', () => {
    assert.ok(typeof PRIVATE_CHANGELOG === 'string');
    assert.ok(PRIVATE_CHANGELOG.length > 50);
    assert.ok(PRIVATE_CHANGELOG.includes('internal'));
    assert.ok(PRIVATE_CHANGELOG.includes('JSON'));
  });

  it('both prompts require JSON output format', () => {
    assert.ok(PUBLIC_CHANGELOG.includes('"title"'));
    assert.ok(PUBLIC_CHANGELOG.includes('"entry"'));
    assert.ok(PRIVATE_CHANGELOG.includes('"title"'));
    assert.ok(PRIVATE_CHANGELOG.includes('"entry"'));
  });
});
