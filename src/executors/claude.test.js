import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrace, fetchComments } from './claude.js';

// ---------------------------------------------------------------------------
// buildTrace
// ---------------------------------------------------------------------------

describe('buildTrace', () => {

  it('returns null for null result', () => {
    assert.equal(buildTrace(null, Date.now()), null);
  });

  it('returns null for null startTime', () => {
    assert.equal(buildTrace({ costUsd: 0.5 }, null), null);
  });

  it('returns null for both null', () => {
    assert.equal(buildTrace(null, null), null);
  });

  it('returns correct shape for success result', () => {
    const start = Date.now() - 5000;
    const result = { costUsd: 0.42, subtype: 'success', numTurns: 3, sessionId: 'sess-1' };
    const trace = buildTrace(result, start);

    assert.ok(trace);
    assert.equal(trace.provider, 'anthropic');
    assert.equal(trace.model, 'claude-code');
    assert.ok(trace.duration >= 4900 && trace.duration <= 6000);
    assert.equal(trace.cost, 0.42);
    assert.equal(trace.status, 'success');
    assert.ok(trace.startedAt);
    assert.ok(trace.endedAt);
    assert.equal(trace.opts.turns, 3);
    assert.equal(trace.opts.session_id, 'sess-1');
  });

  it('returns error status for error_max_turns subtype', () => {
    const start = Date.now() - 1000;
    const result = { costUsd: 1.0, subtype: 'error_max_turns', numTurns: 25, sessionId: 'sess-2' };
    const trace = buildTrace(result, start);

    assert.ok(trace);
    assert.equal(trace.status, 'error');
  });

  it('returns success status for non-error subtypes', () => {
    for (const subtype of ['success', 'end_turn', null, undefined, '']) {
      const trace = buildTrace({ costUsd: 0, subtype, numTurns: 1, sessionId: null }, Date.now() - 100);
      assert.equal(trace.status, 'success', `subtype "${subtype}" should be success`);
    }
  });

  it('startedAt and endedAt are valid ISO strings', () => {
    const start = Date.now() - 2000;
    const trace = buildTrace({ costUsd: 0, subtype: 'success', numTurns: 1, sessionId: null }, start);

    const parsed = new Date(trace.startedAt);
    assert.ok(!isNaN(parsed.getTime()), 'startedAt should be valid ISO date');
    const parsedEnd = new Date(trace.endedAt);
    assert.ok(!isNaN(parsedEnd.getTime()), 'endedAt should be valid ISO date');
    assert.ok(parsedEnd >= parsed, 'endedAt should be after startedAt');
  });

  it('handles zero costUsd', () => {
    const trace = buildTrace({ costUsd: 0, numTurns: 1, sessionId: null }, Date.now());
    assert.equal(trace.cost, 0);
  });

  it('handles null costUsd', () => {
    const trace = buildTrace({ costUsd: null, numTurns: 1, sessionId: null }, Date.now());
    assert.equal(trace.cost, null);
  });
});

// ---------------------------------------------------------------------------
// fetchComments
// ---------------------------------------------------------------------------

describe('fetchComments', () => {

  it('returns empty when no comments', () => {
    const issues = { getIssueComments: () => [] };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.equal(result.commentsText, '');
    assert.equal(result.lastHumanMessage, null);
  });

  it('returns empty on error', () => {
    const issues = { getIssueComments: () => { throw new Error('API error'); } };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.equal(result.commentsText, '');
    assert.equal(result.lastHumanMessage, null);
  });

  it('formats comments with user login', () => {
    const issues = {
      getIssueComments: () => [
        { user: { login: 'alice' }, body: 'Looks good!' },
        { user: { login: 'bob' }, body: 'One concern.' },
      ],
    };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.ok(result.commentsText.includes('**alice:**'));
    assert.ok(result.commentsText.includes('Looks good!'));
    assert.ok(result.commentsText.includes('**bob:**'));
    assert.ok(result.commentsText.includes('One concern.'));
  });

  it('finds last human message (not warp-coder)', () => {
    const issues = {
      getIssueComments: () => [
        { user: { login: 'alice' }, body: 'Please fix the build' },
        { user: { login: 'warp-coder-bot' }, body: 'Done — warp-coder processed' },
      ],
    };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.equal(result.lastHumanMessage, 'Please fix the build');
  });

  it('strips HTML comments from bodies', () => {
    const issues = {
      getIssueComments: () => [
        { user: { login: 'alice' }, body: '<!-- hidden comment -->\nVisible text' },
      ],
    };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.ok(result.commentsText.includes('Visible text'));
    assert.ok(!result.commentsText.includes('hidden comment'));
  });

  it('handles comments with empty body', () => {
    const issues = {
      getIssueComments: () => [
        { user: { login: 'alice' }, body: '' },
        { user: { login: 'bob' }, body: 'Real comment' },
      ],
    };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.ok(!result.commentsText.includes('**alice:**'));
    assert.ok(result.commentsText.includes('**bob:**'));
  });

  it('handles comments with null user', () => {
    const issues = {
      getIssueComments: () => [
        { user: null, body: 'Anonymous comment' },
      ],
    };
    const result = fetchComments(issues, 42, 'owner/repo');
    assert.ok(result.commentsText.includes('**unknown:**'));
  });
});
