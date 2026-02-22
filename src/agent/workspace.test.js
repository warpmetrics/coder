import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gitExclude } from './workspace.js';

function makeGitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ws-test-'));
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  return dir;
}

describe('gitExclude', () => {
  it('creates exclude entries when file does not exist', () => {
    const dir = makeGitDir();
    gitExclude(dir, ['.warp-coder-ask']);
    const content = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.ok(content.includes('.warp-coder-ask'));
  });

  it('appends entries to existing exclude file', () => {
    const dir = makeGitDir();
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.log\n');
    gitExclude(dir, ['.warp-coder-ask']);
    const content = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.ok(content.includes('*.log'));
    assert.ok(content.includes('.warp-coder-ask'));
  });

  it('does not duplicate existing entries', () => {
    const dir = makeGitDir();
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.warp-coder-ask\n');
    gitExclude(dir, ['.warp-coder-ask']);
    const content = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    const count = content.split('.warp-coder-ask').length - 1;
    assert.equal(count, 1, 'should not duplicate existing entry');
  });

  it('handles multiple entries at once', () => {
    const dir = makeGitDir();
    gitExclude(dir, ['.warp-coder-ask', '.warp-coder-tmp']);
    const content = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.ok(content.includes('.warp-coder-ask'));
    assert.ok(content.includes('.warp-coder-tmp'));
  });

  it('handles empty entries array', () => {
    const dir = makeGitDir();
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'original\n');
    gitExclude(dir, []);
    const content = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.equal(content, 'original\n');
  });

  it('handles exclude file without trailing newline', () => {
    const dir = makeGitDir();
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.log');
    gitExclude(dir, ['.tmp']);
    const content = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.ok(content.includes('*.log'));
    assert.ok(content.includes('.tmp'));
    // Each entry should be on its own line
    const lines = content.split('\n').filter(Boolean);
    assert.ok(lines.includes('*.log'));
    assert.ok(lines.includes('.tmp'));
  });
});
