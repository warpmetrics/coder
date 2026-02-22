// Claude Code client — subprocess runner, trace builder, and pipeline-scoped wrapper.

import { spawn } from 'child_process';
import { TIMEOUTS } from '../defaults.js';

const DEFAULT_TIMEOUT = TIMEOUTS.CLAUDE;

// ---------------------------------------------------------------------------
// Raw subprocess runner
// ---------------------------------------------------------------------------

export function rawRun({ prompt, workdir, allowedTools, disallowedTools, maxTurns, resume, jsonSchema, noSessionPersistence, timeout = DEFAULT_TIMEOUT, verbose = true, logPrefix = '', onBeforeLog }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (resume) args.push('--resume', resume);
    if (noSessionPersistence) args.push('--no-session-persistence');
    if (allowedTools) args.push('--allowedTools', allowedTools);
    if (disallowedTools) args.push('--disallowedTools', ...disallowedTools);
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resultEvent = null;
    let lastAssistantText = '';
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let pendingTools = [];
    let settled = false;

    function settle(fn) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    }

    const timer = timeout ? setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, TIMEOUTS.SIGKILL_GRACE);
      settle(() => reject(new Error(`Claude timed out after ${Math.round(timeout / 1000)}s`)));
    }, timeout) : null;

    function flushTools() {
      if (pendingTools.length === 0) return;
      if (onBeforeLog) onBeforeLog();
      process.stderr.write(`[${new Date().toISOString()}] ${logPrefix}  claude: ${pendingTools.join(', ')}\n`);
      pendingTools = [];
    }

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            resultEvent = event;
          } else if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                lastAssistantText = block.text;
                if (verbose) {
                  flushTools();
                  const text = block.text.replace(/\n/g, ' ').trim();
                  if (text) {
                    if (onBeforeLog) onBeforeLog();
                    process.stderr.write(`[${new Date().toISOString()}] ${logPrefix}  claude: ${text.slice(0, 300)}\n`);
                  }
                }
              } else if (block.type === 'tool_use') {
                if (verbose) pendingTools.push(block.name);
              }
            }
          }
        } catch {
          // not valid JSON, skip
        }
      }
    });

    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (verbose) flushTools();
      settle(() => {
        if (code !== 0) {
          return reject(new Error(`claude exited with code ${code}: ${stderr}`));
        }
        resolve({
          result: resultEvent?.result ?? lastAssistantText,
          structuredOutput: resultEvent?.structured_output ?? null,
          sessionId: resultEvent?.session_id ?? null,
          costUsd: resultEvent?.total_cost_usd ?? null,
          subtype: resultEvent?.subtype ?? null,
          numTurns: resultEvent?.num_turns ?? null,
        });
      });
    });

    proc.on('error', err => settle(() => reject(err)));
  });
}

// ---------------------------------------------------------------------------
// Trace builder
// ---------------------------------------------------------------------------

export function buildTrace(result, startTime, { prompt } = {}) {
  if (!result || !startTime) return null;
  const duration = Date.now() - startTime;
  return {
    provider: 'anthropic', model: 'claude-code', duration,
    startedAt: new Date(startTime).toISOString(),
    endedAt: new Date(startTime + duration).toISOString(),
    cost: result.costUsd,
    status: result.subtype === 'error_max_turns' ? 'error' : 'success',
    messages: prompt ? [{ role: 'user', content: prompt }] : null,
    response: result.result || null,
    opts: { turns: result.numTurns, session_id: result.sessionId },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fetchComments(issues, issueId, repo, log) {
  try {
    const comments = issues.getIssueComments(issueId, { repo });
    if (!comments.length) return { commentsText: '', lastHumanMessage: null };
    const lastHuman = [...comments].reverse().find(c => !(c.body || '').includes('warp-coder'));
    const strip = s => (s || '').replace(/<!--[\s\S]*?-->\n*/g, '').trim();
    return {
      lastHumanMessage: lastHuman ? strip(lastHuman.body) : null,
      commentsText: comments.map(c => {
        const body = strip(c.body);
        return body ? `**${c.user?.login || 'unknown'}:** ${body}` : null;
      }).filter(Boolean).join('\n\n'),
    };
  } catch (err) {
    log?.(`  warning: fetchComments failed: ${err.message}`);
    return { commentsText: '', lastHumanMessage: null };
  }
}

// ---------------------------------------------------------------------------
// Pipeline-scoped client
// ---------------------------------------------------------------------------

export function createClaudeCodeClient({ warp, apiKey, config }) {

  async function run({ prompt, workdir, pipelineRunId, ...opts }) {
    const start = Date.now();
    let result;
    try {
      result = await rawRun({
        prompt,
        workdir: workdir || process.cwd(),
        allowedTools: opts.allowedTools ?? config.claude?.allowedTools,
        disallowedTools: opts.disallowedTools,
        maxTurns: opts.maxTurns ?? config.claude?.maxTurns,
        resume: opts.resume,
        jsonSchema: opts.jsonSchema,
        noSessionPersistence: opts.noSessionPersistence,
        timeout: opts.timeout,
        logPrefix: opts.logPrefix,
        onBeforeLog: opts.onBeforeLog,
        verbose: opts.verbose,
      });
    } catch (err) {
      if (pipelineRunId && apiKey) {
        const trace = buildTrace({ costUsd: 0, result: null, subtype: 'error' }, start, { prompt });
        if (trace) {
          trace.status = 'error';
          trace.error = err.message;
          try { await warp.traceClaudeCall(apiKey, pipelineRunId, trace); } catch {}
        }
      }
      throw err;
    }

    const trace = buildTrace(result, start, { prompt });
    if (pipelineRunId && apiKey && trace) {
      try { await warp.traceClaudeCall(apiKey, pipelineRunId, trace); } catch (err) {
        process.stderr.write(`[${new Date().toISOString()}] warning: traceClaudeCall failed: ${err.message}\n`);
      }
    }

    return { ...result, trace, hitMaxTurns: result.subtype === 'error_max_turns' };
  }

  function forRun(pipelineRunId) {
    return {
      run: (opts) => run({ ...opts, pipelineRunId }),
    };
  }

  return { run, forRun };
}
