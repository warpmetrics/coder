import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, REVIEW_SCHEMA, VERDICTS, ReviewVerdictSchema } from './prompt.js';
import { extractReviewJson } from './index.js';
import { z } from 'zod';

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

  it('directs Claude to read review skills', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('.claude/skills/'));
    assert.ok(prompt.includes('SKILL.md'));
    assert.ok(prompt.includes('review criteria'));
  });

  it('forbids file modification and gh commands', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('no Edit'));
    assert.ok(prompt.includes('no Write'));
    assert.ok(prompt.includes('gh'));
  });

  it('includes JSON Schema with verdict enum and field descriptions', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('"verdict"'));
    assert.ok(prompt.includes('"summary"'));
    assert.ok(prompt.includes('"comments"'));
    assert.ok(prompt.includes('"approve"'));
    assert.ok(prompt.includes('"request_changes"'));
  });

  it('includes strict line number rules', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(prompt.includes('NEW version of the file'));
    assert.ok(prompt.includes('changed diff hunk'));
    assert.ok(prompt.includes('OMIT the `line` field'));
    assert.ok(prompt.includes('NEVER use line numbers from the old file'));
  });

  it('does not hardcode review criteria or verdict rules', () => {
    const prompt = buildReviewPrompt(defaults);
    assert.ok(!prompt.includes('Correctness'));
    assert.ok(!prompt.includes('request_changes`: For bugs'));
  });

  it('includes verdict rules derived from VERDICTS', () => {
    const prompt = buildReviewPrompt(defaults);
    for (const [val, desc] of Object.entries(VERDICTS)) {
      assert.ok(prompt.includes(`\`${val}\``), `should include verdict ${val}`);
      assert.ok(prompt.includes(desc), `should include description for ${val}`);
    }
  });
});

// ---------------------------------------------------------------------------
// REVIEW_SCHEMA (generated via z.toJSONSchema)
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

// ---------------------------------------------------------------------------
// ReviewVerdictSchema (Zod)
// ---------------------------------------------------------------------------

describe('ReviewVerdictSchema', () => {

  it('parses a valid verdict', () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: 'approve',
      summary: 'Looks good',
      comments: [{ path: 'src/index.js', body: 'Minor nit' }],
    });
    assert.ok(result.success);
  });

  it('rejects invalid verdict value', () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: 'invalid',
      summary: 'Looks good',
      comments: [],
    });
    assert.ok(!result.success);
  });

  it('allows optional line on comments', () => {
    const result = ReviewVerdictSchema.safeParse({
      verdict: 'request_changes',
      summary: 'Issues found',
      comments: [
        { path: 'a.js', body: 'Bug', line: 42 },
        { path: 'b.js', body: 'Missing guard' },
      ],
    });
    assert.ok(result.success);
  });
});

// ---------------------------------------------------------------------------
// extractReviewJson
// ---------------------------------------------------------------------------

describe('extractReviewJson', () => {

  it('extracts from clean fenced block', () => {
    const text = 'Some analysis\n```json\n{"verdict":"approve","summary":"ok","comments":[]}\n```';
    const result = extractReviewJson(text);
    assert.equal(result.verdict, 'approve');
  });

  it('extracts when comments contain embedded code fences', () => {
    const json = JSON.stringify({
      verdict: 'request_changes',
      summary: 'Issues found',
      comments: [{ path: 'a.js', body: 'Fix:\n```js\nif (x) {}\n```' }],
    });
    const text = `Analysis here\n\`\`\`json\n${json}\n\`\`\``;
    const result = extractReviewJson(text);
    assert.equal(result.verdict, 'request_changes');
    assert.equal(result.comments.length, 1);
    assert.ok(result.comments[0].body.includes('```js'));
  });

  it('extracts from bare JSON without fence', () => {
    const text = 'Some text\n{"verdict":"approve","summary":"ok","comments":[]}';
    const result = extractReviewJson(text);
    assert.equal(result.verdict, 'approve');
  });

  it('returns null for empty input', () => {
    assert.equal(extractReviewJson(null), null);
    assert.equal(extractReviewJson(''), null);
  });

  it('returns null for text without JSON', () => {
    assert.equal(extractReviewJson('no json here'), null);
  });
});
