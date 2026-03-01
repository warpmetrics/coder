import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanForNewComment, evaluateInterrupt } from './interrupt.js';

// ---------------------------------------------------------------------------
// scanForNewComment
// ---------------------------------------------------------------------------

describe('scanForNewComment', () => {
  it('returns null when no comments', async () => {
    const issues = { getIssueComments: () => [] };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result, null);
  });

  it('returns null when getIssueComments throws', async () => {
    const issues = { getIssueComments: () => { throw new Error('API error'); } };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result, null);
  });

  it('returns null when no bot comment exists and no human comments', async () => {
    const issues = { getIssueComments: () => [] };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result, null);
  });

  it('returns human comment when it exists after bot comment', async () => {
    const issues = {
      getIssueComments: () => [
        { id: 1, body: '<!-- warp-coder:error -->\nImplementation failed', user: { login: 'bot' } },
        { id: 2, body: 'please retry', user: { login: 'alice' } },
      ],
    };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result.id, 2);
    assert.equal(result.body, 'please retry');
  });

  it('returns null when no human comment after bot comment', async () => {
    const issues = {
      getIssueComments: () => [
        { id: 1, body: 'please retry', user: { login: 'alice' } },
        { id: 2, body: '<!-- warp-coder:error -->\nFailed again', user: { login: 'bot' } },
      ],
    };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result, null);
  });

  it('skips bot comments (containing warp-coder)', async () => {
    const issues = {
      getIssueComments: () => [
        { id: 1, body: '<!-- warp-coder:error -->\nFailed', user: { login: 'bot' } },
        { id: 2, body: '<!-- warp-coder:status -->\nRetrying', user: { login: 'bot' } },
      ],
    };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result, null);
  });

  it('skips already-processed comment IDs', async () => {
    const issues = {
      getIssueComments: () => [
        { id: 1, body: '<!-- warp-coder:error -->\nFailed', user: { login: 'bot' } },
        { id: 2, body: 'retry', user: { login: 'alice' } },
      ],
    };
    const processed = new Map([[42, new Set([2])]]);
    const result = await scanForNewComment(issues, 42, 'owner/repo', processed);
    assert.equal(result, null);
  });

  it('returns first unprocessed comment when some are processed', async () => {
    const issues = {
      getIssueComments: () => [
        { id: 1, body: '<!-- warp-coder:error -->\nFailed', user: { login: 'bot' } },
        { id: 2, body: 'retry', user: { login: 'alice' } },
        { id: 3, body: 'actually cancel', user: { login: 'alice' } },
      ],
    };
    const processed = new Map([[42, new Set([2])]]);
    const result = await scanForNewComment(issues, 42, 'owner/repo', processed);
    assert.equal(result.id, 3);
    assert.equal(result.body, 'actually cancel');
  });

  it('returns human comment even when no bot comment exists', async () => {
    const issues = {
      getIssueComments: () => [
        { id: 1, body: 'retry this please', user: { login: 'alice' } },
      ],
    };
    const result = await scanForNewComment(issues, 42, 'owner/repo', new Map());
    assert.equal(result.id, 1);
  });
});

// ---------------------------------------------------------------------------
// evaluateInterrupt
// ---------------------------------------------------------------------------

describe('evaluateInterrupt', () => {
  const makeComment = (body) => ({ id: 99, body, user: { login: 'alice' } });
  const makeRun = () => ({
    id: 'run-1', issueId: 42, repo: 'owner/repo',
    title: 'Fix bug', latestOutcome: 'Implementation Failed',
    outcomes: [], pendingAct: null,
  });
  const makeTriggers = () => [
    { name: 'reset', type: 'reset', label: 'Reset to Checkpoint' },
    { name: 'cancel', type: 'global', label: 'Cancel' },
    { name: 'ship', type: 'global', label: 'Ship' },
  ];

  it('returns trigger name when LLM picks a trigger', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: { action: 'reset', reason: 'User asked to retry' },
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('retry'), makeRun(), makeTriggers());
    assert.equal(result.action, 'reset');
    assert.equal(result.reason, 'User asked to retry');
  });

  it('returns trigger name with phase when LLM specifies phase', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: { action: 'reset', phase: 'Build', reason: 'Go back to implement' },
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('go back to planning'), makeRun(), makeTriggers());
    assert.equal(result.action, 'reset');
    assert.equal(result.phase, 'Build');
  });

  it('returns none when LLM says none', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: { action: 'none', reason: 'Just a status update' },
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('looks good'), makeRun(), makeTriggers());
    assert.equal(result.action, 'none');
  });

  it('returns cancel when LLM picks cancel trigger', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: { action: 'cancel', reason: 'User wants to abandon' },
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('nevermind'), makeRun(), makeTriggers());
    assert.equal(result.action, 'cancel');
  });

  it('returns ship when LLM picks ship trigger', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: { action: 'ship', reason: 'User says it is done' },
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('ship it'), makeRun(), makeTriggers());
    assert.equal(result.action, 'ship');
  });

  it('returns none on LLM parse failure', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: null,
        result: 'not valid json',
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('retry'), makeRun(), makeTriggers());
    assert.equal(result.action, 'none');
    assert.ok(result.reason.includes('parse failure'));
  });

  it('returns none when LLM throws', async () => {
    const claudeCode = {
      run: async () => { throw new Error('Claude timeout'); },
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('retry'), makeRun(), makeTriggers());
    assert.equal(result.action, 'none');
    assert.ok(result.reason.includes('Claude timeout'));
  });

  it('returns none when action not in available triggers', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: { action: 'ship', reason: 'User wants to ship' },
      }),
    };
    // Only reset available, not ship
    const triggers = [{ name: 'reset', type: 'reset', label: 'Reset' }];
    const result = await evaluateInterrupt(claudeCode, makeComment('ship it'), makeRun(), triggers);
    assert.equal(result.action, 'none');
  });

  it('falls back to parsing result text as JSON', async () => {
    const claudeCode = {
      run: async () => ({
        structuredOutput: null,
        result: JSON.stringify({ action: 'reset', reason: 'parsed from text' }),
      }),
    };
    const result = await evaluateInterrupt(claudeCode, makeComment('retry'), makeRun(), makeTriggers());
    assert.equal(result.action, 'reset');
    assert.equal(result.reason, 'parsed from text');
  });

  it('passes trigger names to the schema', async () => {
    let capturedSchema;
    const claudeCode = {
      run: async (opts) => {
        capturedSchema = opts.jsonSchema;
        return { structuredOutput: { action: 'none', reason: 'test' } };
      },
    };
    const triggers = [
      { name: 'custom_trigger', type: 'global', label: 'Custom' },
    ];
    await evaluateInterrupt(claudeCode, makeComment('test'), makeRun(), triggers);
    // Schema should include 'none' and 'custom_trigger' as valid actions
    const actionEnum = capturedSchema.properties.action.enum;
    assert.ok(actionEnum.includes('none'));
    assert.ok(actionEnum.includes('custom_trigger'));
    assert.equal(actionEnum.length, 2);
  });
});
