import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_CHANGELOG,
  PRIVATE_CHANGELOG,
  ChangelogEntrySchema,
  CHANGELOG_ENTRY_SCHEMA,
} from './prompt.js';

// ---------------------------------------------------------------------------
// Changelog prompts
// ---------------------------------------------------------------------------

describe('changelog prompts', () => {

  it('PUBLIC_CHANGELOG is non-empty', () => {
    assert.ok(typeof PUBLIC_CHANGELOG === 'string');
    assert.ok(PUBLIC_CHANGELOG.length > 50);
    assert.ok(PUBLIC_CHANGELOG.includes('public'));
  });

  it('PRIVATE_CHANGELOG is non-empty', () => {
    assert.ok(typeof PRIVATE_CHANGELOG === 'string');
    assert.ok(PRIVATE_CHANGELOG.length > 50);
    assert.ok(PRIVATE_CHANGELOG.includes('internal'));
  });

  it('ChangelogEntrySchema validates correct entries', () => {
    const result = ChangelogEntrySchema.safeParse({
      title: 'Test title',
      entry: 'Some changes',
      tags: ['feature'],
    });
    assert.ok(result.success);
  });

  it('ChangelogEntrySchema rejects invalid entries', () => {
    const result = ChangelogEntrySchema.safeParse({ title: 'Only title' });
    assert.ok(!result.success);
  });

  it('CHANGELOG_ENTRY_SCHEMA is a valid JSON schema', () => {
    assert.ok(typeof CHANGELOG_ENTRY_SCHEMA === 'object');
    assert.ok(CHANGELOG_ENTRY_SCHEMA.properties?.title);
    assert.ok(CHANGELOG_ENTRY_SCHEMA.properties?.entry);
    assert.ok(CHANGELOG_ENTRY_SCHEMA.properties?.tags);
  });
});
