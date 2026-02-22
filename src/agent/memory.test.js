import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMemory, saveMemory } from './memory.js';

describe('loadMemory', () => {
  it('returns empty string when file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-test-'));
    assert.equal(loadMemory(dir), '');
  });

  it('returns file contents when file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-test-'));
    saveMemory(dir, '# Lessons\n- test\n');
    assert.equal(loadMemory(dir), '# Lessons\n- test\n');
  });
});

describe('saveMemory', () => {
  it('creates the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-test-'));
    saveMemory(dir, 'hello');
    assert.equal(readFileSync(join(dir, 'memory.md'), 'utf-8'), 'hello');
  });

  it('overwrites existing content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-test-'));
    saveMemory(dir, 'first');
    saveMemory(dir, 'second');
    assert.equal(readFileSync(join(dir, 'memory.md'), 'utf-8'), 'second');
  });
});
