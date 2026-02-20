import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateId } from '../src/client/warp.js';

describe('generateId', () => {
  it('starts with wm_ prefix', () => {
    const id = generateId('run');
    assert.match(id, /^wm_run_/);
  });

  it('embeds the given prefix', () => {
    for (const prefix of ['run', 'grp', 'oc', 'act']) {
      const id = generateId(prefix);
      assert.ok(id.startsWith(`wm_${prefix}_`), `expected wm_${prefix}_ prefix, got ${id}`);
    }
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('run')));
    assert.equal(ids.size, 100);
  });

  it('has consistent length', () => {
    const ids = Array.from({ length: 10 }, () => generateId('run'));
    const lengths = new Set(ids.map(id => id.length));
    assert.equal(lengths.size, 1, `expected consistent length, got ${[...lengths]}`);
  });
});
