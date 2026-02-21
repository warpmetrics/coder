import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_CHANGELOG,
  PRIVATE_CHANGELOG,
} from './prompt.js';

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
