import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/clients/boards/index.js';
import { createPRClient } from '../src/clients/prs/index.js';
import { createIssueClient } from '../src/clients/issues/index.js';
import { createNotifier } from '../src/clients/notify/index.js';

// ---------------------------------------------------------------------------
// createBoard
// ---------------------------------------------------------------------------

describe('createBoard factory', () => {

  it('throws for unknown provider', () => {
    assert.throws(
      () => createBoard({ board: { provider: 'jira' } }),
      { message: /Unknown board provider: jira/ },
    );
  });

  it('throws when no provider specified', () => {
    assert.throws(
      () => createBoard({ board: {} }),
      { message: /Unknown board provider/ },
    );
  });

  it('error message lists available providers', () => {
    try {
      createBoard({ board: { provider: 'notion' } });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err.message.includes('github'));
      assert.ok(err.message.includes('linear'));
    }
  });
});

// ---------------------------------------------------------------------------
// createPRClient
// ---------------------------------------------------------------------------

describe('createPRClient factory', () => {

  it('throws for unknown provider', () => {
    assert.throws(
      () => createPRClient({ codehost: { provider: 'gitlab' } }),
      { message: /Unknown PR provider: gitlab/ },
    );
  });

  it('error message lists available providers', () => {
    try {
      createPRClient({ codehost: { provider: 'bitbucket' } });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err.message.includes('github'));
    }
  });

  it('defaults to github when no provider specified', () => {
    const client = createPRClient({});
    assert.ok(typeof client.createPR === 'function');
    assert.ok(typeof client.mergePR === 'function');
    assert.ok(typeof client.classifyReviewItems === 'function');
  });

  it('defaults to github when config is null', () => {
    const client = createPRClient(null);
    assert.ok(typeof client.mergePR === 'function');
  });
});

// ---------------------------------------------------------------------------
// createIssueClient
// ---------------------------------------------------------------------------

describe('createIssueClient factory', () => {

  it('throws for unknown provider', () => {
    assert.throws(
      () => createIssueClient({ issues: { provider: 'jira' } }),
      { message: /Unknown issue provider: jira/ },
    );
  });

  it('falls back to codehost provider', () => {
    const client = createIssueClient({ codehost: { provider: 'github' } });
    assert.ok(typeof client.getIssueBody === 'function');
  });

  it('defaults to github when no provider specified', () => {
    const client = createIssueClient({});
    assert.ok(typeof client.getIssueBody === 'function');
    assert.ok(typeof client.getIssueComments === 'function');
    assert.ok(typeof client.addLabels === 'function');
  });
});

// ---------------------------------------------------------------------------
// createNotifier
// ---------------------------------------------------------------------------

describe('createNotifier factory', () => {

  it('throws for unknown provider in channels', () => {
    assert.throws(
      () => createNotifier({ notify: [{ provider: 'foobar' }] }),
      { message: /Unknown notify provider: foobar/ },
    );
  });

  it('creates telegram provider without error', () => {
    const notifier = createNotifier({ notify: [{ provider: 'telegram', chatId: '-100123' }] });
    assert.ok(typeof notifier.comment === 'function');
  });

  it('defaults to github when no notify config', () => {
    const notifier = createNotifier({});
    assert.ok(typeof notifier.comment === 'function');
  });

  it('defaults to github when config is null', () => {
    const notifier = createNotifier(null);
    assert.ok(typeof notifier.comment === 'function');
  });
});
