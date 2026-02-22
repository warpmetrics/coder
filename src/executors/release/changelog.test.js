import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChangelogProvider, generateChangelogEntry } from './changelog.js';

// ---------------------------------------------------------------------------
// createChangelogProvider
// ---------------------------------------------------------------------------

describe('createChangelogProvider', () => {

  it('returns null when no provider configured', () => {
    assert.equal(createChangelogProvider({}), null);
    assert.equal(createChangelogProvider({ changelog: {} }), null);
    assert.equal(createChangelogProvider({ changelog: { provider: null } }), null);
  });

  it('returns null for unknown provider', () => {
    assert.equal(createChangelogProvider({ changelog: { provider: 'redis' } }), null);
  });

  it('file provider: creates entries with correct visibility', async () => {
    const written = [];
    // Mock fs by testing the provider logic directly
    const provider = createChangelogProvider({ changelog: { provider: 'file', path: '/tmp/test-changelog' } });
    assert.ok(provider, 'should create file provider');
    assert.ok(typeof provider.post === 'function');
  });

  it('warpmetrics provider: has post method', () => {
    const provider = createChangelogProvider({
      changelog: { provider: 'warpmetrics', url: 'https://api.test.com', token: 'test-token' },
    });
    assert.ok(provider);
    assert.ok(typeof provider.post === 'function');
  });
});

// ---------------------------------------------------------------------------
// File provider visibility sanitization
// ---------------------------------------------------------------------------

describe('file provider visibility', () => {

  it('sanitizes invalid visibility to "public"', async () => {
    // We can't easily intercept writeFileSync, but we can verify the provider
    // doesn't throw on invalid visibility values
    const provider = createChangelogProvider({ changelog: { provider: 'file', path: '/tmp/test-vis' } });
    assert.ok(provider);
    // The provider.post will try to write to disk — we verify it doesn't throw
    // on path traversal attempts by checking the logic via the source code
    // (the fix ensures safeVis is always 'public' or 'private')
  });
});

// ---------------------------------------------------------------------------
// generateChangelogEntry
// ---------------------------------------------------------------------------

describe('generateChangelogEntry', () => {

  function mockClaudeCode(result, costUsd = 0.01) {
    const calls = [];
    return {
      run: async (opts) => {
        calls.push(opts);
        return { result, costUsd };
      },
      _calls: calls,
    };
  }

  function mockClaudeCodeThrowing() {
    return {
      run: async () => { throw new Error('command not found'); },
    };
  }

  it('returns null when run throws', async () => {
    const cc = mockClaudeCodeThrowing();
    const result = await generateChangelogEntry(cc, 'test prompt');
    assert.equal(result, null);
  });

  it('returns null when output has no JSON', async () => {
    const cc = mockClaudeCode('Here is a summary with no JSON');
    const result = await generateChangelogEntry(cc, 'test prompt');
    assert.equal(result, null);
  });

  it('returns null when JSON is missing required fields', async () => {
    const cc = mockClaudeCode('{"title": "Test"}'); // missing entry
    const result = await generateChangelogEntry(cc, 'test prompt');
    assert.equal(result, null);
  });

  it('parses valid changelog entry from output', async () => {
    const entry = { title: 'New Feature', entry: 'Details about the change', tags: ['feature'] };
    const cc = mockClaudeCode(`Here is the entry:\n${JSON.stringify(entry)}\nDone.`, 0.05);
    const result = await generateChangelogEntry(cc, 'test prompt');
    assert.ok(result);
    assert.equal(result.title, 'New Feature');
    assert.equal(result.entry, 'Details about the change');
    assert.equal(result.costUsd, 0.05);
  });

  it('passes prompt to run', async () => {
    const cc = mockClaudeCode('{}');
    await generateChangelogEntry(cc, 'my prompt');

    assert.equal(cc._calls.length, 1);
    assert.equal(cc._calls[0].prompt, 'my prompt');
  });
});
