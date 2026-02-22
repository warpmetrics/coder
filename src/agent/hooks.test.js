import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, safeHook } from './hooks.js';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const workdir = mkdtempSync(join(tmpdir(), 'hooks-test-'));

describe('runHook', () => {
  it('returns { ran: false } when hook is not configured', () => {
    const result = runHook('onBeforePush', {}, { workdir });
    assert.deepEqual(result, { ran: false });
  });

  it('returns { ran: false } when hooks object is missing', () => {
    const result = runHook('onBeforePush', { hooks: {} }, { workdir });
    assert.deepEqual(result, { ran: false });
  });

  it('runs a successful hook and returns stdout', () => {
    const config = { hooks: { test: 'echo hello' } };
    const result = runHook('test', config, { workdir });
    assert.equal(result.ran, true);
    assert.equal(result.hook, 'test');
    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.stderr, '');
    assert.equal(result.exitCode, 0);
  });

  it('sets environment variables from context', () => {
    const config = { hooks: { test: 'echo $ISSUE_NUMBER $PR_NUMBER $BRANCH $REPO' } };
    const context = { workdir, issueNumber: 42, prNumber: 7, branch: 'main', repo: 'org/app' };
    const result = runHook('test', config, context);
    assert.equal(result.stdout.trim(), '42 7 main org/app');
  });

  it('omits env vars when context fields are missing', () => {
    const config = { hooks: { test: 'echo ${ISSUE_NUMBER:-none}' } };
    const result = runHook('test', config, { workdir });
    assert.equal(result.stdout.trim(), 'none');
  });

  it('throws on hook failure with hookResult attached', () => {
    const config = { hooks: { test: 'exit 1' } };
    try {
      runHook('test', config, { workdir });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Hook "test" failed'));
      assert.ok(err.hookResult);
      assert.equal(err.hookResult.ran, true);
      assert.equal(err.hookResult.exitCode, 1);
    }
  });

  it('captures stderr on failure', () => {
    const config = { hooks: { test: 'echo oops >&2; exit 2' } };
    try {
      runHook('test', config, { workdir });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.hookResult.exitCode, 2);
      assert.ok(err.hookResult.stderr.includes('oops'));
    }
  });

  it('uses config.hooks.timeout when set', () => {
    // timeout=1 means 1 second — the echo should finish well within that
    const config = { hooks: { test: 'echo fast', timeout: 1 } };
    const result = runHook('test', config, { workdir });
    assert.equal(result.ran, true);
  });
});

describe('safeHook', () => {
  it('pushes successful hook result to hookOutputs', () => {
    const outputs = [];
    const config = { hooks: { test: 'echo ok' } };
    safeHook('test', config, { workdir }, outputs);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].ran, true);
    assert.equal(outputs[0].exitCode, 0);
  });

  it('does not push when hook is not configured', () => {
    const outputs = [];
    safeHook('missing', {}, { workdir }, outputs);
    assert.equal(outputs.length, 0);
  });

  it('pushes hookResult and re-throws on failure', () => {
    const outputs = [];
    const config = { hooks: { test: 'exit 1' } };
    assert.throws(() => safeHook('test', config, { workdir }, outputs));
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].exitCode, 1);
  });
});
