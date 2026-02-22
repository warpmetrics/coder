import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, REVIEW_SCHEMA } from './prompt.js';

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

describe('buildReviewPrompt', () => {

  const defaults = {
    workdir: '/tmp/review-42',
    repoDirs: [{ dirName: 'api', name: 'org/api', prNumber: 1, branch: 'agent/issue-42' }],
    issueId: 42,
    issueTitle: 'Fix bug',
    issueBody: '',
    commentsText: '',
  };

  it('includes workspace layout with repos and branches', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('/tmp/review-42'));
    assert.ok(prompt.includes('api'));
    assert.ok(prompt.includes('PR #1'));
    assert.ok(prompt.includes('agent/issue-42'));
  });

  it('includes issue context', () => {
    const prompt = buildReviewPrompt({
      ...defaults,
      issueTitle: 'Fix login',
      issueBody: 'Login is broken on Safari',
    });
    assert.ok(prompt.includes('Fix login'));
    assert.ok(prompt.includes('Login is broken on Safari'));
  });

  it('includes git diff instructions', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('git diff origin/main...HEAD --stat'));
    assert.ok(prompt.includes('git diff origin/main...HEAD -- path/to/file.js'));
  });

  it('does NOT include diff content', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(!prompt.includes('```diff'));
  });

  it('includes review criteria', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('Correctness'));
    assert.ok(prompt.includes('Security'));
    assert.ok(prompt.includes('Completeness'));
    assert.ok(prompt.includes('Error handling'));
  });

  it('forbids file modification and gh commands', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('no Edit'));
    assert.ok(prompt.includes('no Write'));
    assert.ok(prompt.includes('gh'));
  });

  it('includes JSON verdict format with fenced code block instruction', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('```json'));
    assert.ok(prompt.includes('"verdict"'));
    assert.ok(prompt.includes('"summary"'));
    assert.ok(prompt.includes('"comments"'));
  });

  it('includes strict line number rules', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('NEW version of the file'));
    assert.ok(prompt.includes('changed diff hunk'));
    assert.ok(prompt.includes('OMIT the `line` field'));
    assert.ok(prompt.includes('NEVER use line numbers from the old file'));
  });

  it('includes strict verdict rules', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('ONLY for bugs, security vulnerabilities'));
    assert.ok(prompt.includes('minor suggestions or style preferences'));
    assert.ok(prompt.includes('NOT grounds for requesting changes'));
    assert.ok(prompt.includes('Verify your claims against the actual diff'));
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
