import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, REVIEW_SCHEMA } from './prompt.js';

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
    assert.ok(prompt.includes('request changes'));
  });

  it('has strict review stance', () => {
    const prompt = buildReviewPrompt({
      workdir: '/tmp/review-42',
      repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 1 }],
      diffs: [],
      issueId: 42,
      issueTitle: 'Fix bug',
      issueBody: '',
      commentsText: '',
    });
    assert.ok(prompt.includes('When in doubt, request changes'));
    assert.ok(!prompt.includes('Default to'));
  });
});

// ---------------------------------------------------------------------------
// REVIEW_SCHEMA
// ---------------------------------------------------------------------------

describe('REVIEW_SCHEMA', () => {

  it('requires verdict, summary, and comments', () => {
    assert.deepEqual(REVIEW_SCHEMA.required, ['verdict', 'summary', 'comments']);
  });

  it('verdict is enum of approve or request_changes', () => {
    assert.deepEqual(REVIEW_SCHEMA.properties.verdict.enum, ['approve', 'request_changes']);
  });

  it('comments items require path and body', () => {
    assert.deepEqual(REVIEW_SCHEMA.properties.comments.items.required, ['path', 'body']);
  });
});
