import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntentPrompt,
  buildImplementPrompt,
} from './prompt.js';

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

