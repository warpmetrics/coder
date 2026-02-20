import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/boards/index.js';
import { createCodeHost } from '../src/codehosts/index.js';

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
// createCodeHost
// ---------------------------------------------------------------------------

describe('createCodeHost factory', () => {

  it('throws for unknown provider', () => {
    assert.throws(
      () => createCodeHost({ codehost: { provider: 'gitlab' } }),
      { message: /Unknown codehost provider: gitlab/ },
    );
  });

  it('error message lists available providers', () => {
    try {
      createCodeHost({ codehost: { provider: 'bitbucket' } });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err.message.includes('github'));
    }
  });

  it('defaults to github when no provider specified', () => {
    // create() with no config returns a github codehost (which has clone, push, etc.)
    const ch = createCodeHost({});
    assert.ok(typeof ch.clone === 'function');
    assert.ok(typeof ch.push === 'function');
    assert.ok(typeof ch.createPR === 'function');
    assert.ok(typeof ch.classifyReviewItems === 'function');
  });

  it('defaults to github when config is null', () => {
    const ch = createCodeHost(null);
    assert.ok(typeof ch.mergePR === 'function');
  });
});
