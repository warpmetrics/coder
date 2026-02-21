// Unified Claude Code client — wraps raw subprocess runner with config defaults,
// tracing, and pipeline scoping.

import { run as rawRun, buildTrace } from '../executors/claude.js';
import { execFileSync } from 'child_process';

export function createClaudeCodeClient({ warp, apiKey, config }) {

  async function run({ prompt, workdir, pipelineRunId, ...opts }) {
    const start = Date.now();
    const result = await rawRun({
      prompt, workdir,
      allowedTools: opts.allowedTools ?? config.claude?.allowedTools,
      disallowedTools: opts.disallowedTools,
      maxTurns: opts.maxTurns ?? config.claude?.maxTurns,
      resume: opts.resume,
      jsonSchema: opts.jsonSchema,
      timeout: opts.timeout,
      logPrefix: opts.logPrefix,
      onBeforeLog: opts.onBeforeLog,
      verbose: opts.verbose,
    });

    const trace = buildTrace(result, start);
    if (pipelineRunId && apiKey && trace) {
      try { await warp.traceClaudeCall(apiKey, pipelineRunId, trace); } catch {}
    }

    return { ...result, trace, hitMaxTurns: result.subtype === 'error_max_turns' };
  }

  async function oneShot(prompt, { pipelineRunId, model = 'sonnet', timeout = 60000 } = {}) {
    const start = Date.now();
    let resultText = null;
    let costUsd = null;

    try {
      const out = execFileSync('claude', [
        '-p', prompt,
        '--max-turns', '1',
        '--model', model,
        '--no-session-persistence',
        '--output-format', 'json',
      ], { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });

      try {
        const envelope = JSON.parse(out);
        resultText = envelope.result ?? out.trim();
        costUsd = envelope.total_cost_usd ?? null;
      } catch {
        resultText = out.trim();
      }
    } catch (err) {
      const stderr = err.stderr?.toString?.() || '';
      throw new Error(`claude oneShot failed: ${err.message}${stderr ? `\n  stderr: ${stderr.slice(0, 500)}` : ''}`);
    }

    const duration = Date.now() - start;
    if (pipelineRunId && apiKey) {
      const trace = {
        provider: 'anthropic', model, duration,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + duration).toISOString(),
        cost: costUsd, status: 'success',
        opts: { turns: 1 },
      };
      try { await warp.traceClaudeCall(apiKey, pipelineRunId, trace); } catch {}
    }

    return { result: resultText, costUsd };
  }

  function forRun(pipelineRunId) {
    return {
      run: (opts) => run({ ...opts, pipelineRunId }),
      oneShot: (prompt, opts) => oneShot(prompt, { ...opts, pipelineRunId }),
    };
  }

  return { run, oneShot, forRun };
}
