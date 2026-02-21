import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReflectPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// buildReflectPrompt
// ---------------------------------------------------------------------------

describe('buildReflectPrompt', () => {

  it('includes step and outcome', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
    });
    assert.ok(prompt.includes('Step: implement'));
    assert.ok(prompt.includes('Outcome: success'));
  });

  it('includes failure outcome', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'revise', success: false, error: 'timeout', maxLines: 100,
    });
    assert.ok(prompt.includes('Outcome: failure'));
    assert.ok(prompt.includes('timeout'));
  });

  it('includes issue info', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
      issue: { number: 42, title: 'Fix login' },
    });
    assert.ok(prompt.includes('#42'));
    assert.ok(prompt.includes('Fix login'));
  });

  it('includes PR number', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'revise', success: true, maxLines: 100, prNumber: 7,
    });
    assert.ok(prompt.includes('PR: #7'));
  });

  it('includes hook outputs', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
      hookOutputs: [{ hook: 'onBeforePush', exitCode: 0, stdout: 'lint ok', stderr: '' }],
    });
    assert.ok(prompt.includes('Hook outputs'));
    assert.ok(prompt.includes('onBeforePush'));
    assert.ok(prompt.includes('lint ok'));
  });

  it('includes review comments', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'revise', success: true, maxLines: 100,
      reviewComments: [{ user: { login: 'alice' }, body: 'Fix the return type' }],
    });
    assert.ok(prompt.includes('alice'));
    assert.ok(prompt.includes('Fix the return type'));
  });

  it('includes claude output', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
      claudeOutput: 'I fixed the bug by adding null check',
    });
    assert.ok(prompt.includes('Claude output'));
    assert.ok(prompt.includes('null check'));
  });

  it('includes current memory', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '## Testing\n- Always run jest', step: 'implement', success: true, maxLines: 100,
    });
    assert.ok(prompt.includes('Always run jest'));
  });

  it('uses maxLines limit', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 50,
    });
    assert.ok(prompt.includes('50 lines'));
  });

  it('handles no current memory', () => {
    const prompt = buildReflectPrompt({
      currentMemory: '', step: 'implement', success: true, maxLines: 100,
    });
    assert.ok(prompt.includes('no memory yet'));
  });
});
