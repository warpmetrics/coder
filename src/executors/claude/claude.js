import { spawn } from 'child_process';

const DEFAULT_TIMEOUT = 60 * 60 * 1000; // 60 minutes

export function run({ prompt, workdir, allowedTools, disallowedTools, maxTurns, resume, timeout = DEFAULT_TIMEOUT, verbose = true, logPrefix = '', onBeforeLog }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (resume) args.push('--resume', resume);
    if (allowedTools) args.push('--allowedTools', allowedTools);
    if (disallowedTools) args.push('--disallowedTools', ...disallowedTools);
    if (maxTurns) args.push('--max-turns', String(maxTurns));

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
      settle(() => reject(new Error(`Claude timed out after ${Math.round(timeout / 1000)}s`)));
    }, timeout) : null;

    function flushTools() {
      if (pendingTools.length === 0) return;
      if (onBeforeLog) onBeforeLog();
      process.stderr.write(`${logPrefix}  claude: ${pendingTools.join(', ')}\n`);
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
                    process.stderr.write(`${logPrefix}  claude: ${text.slice(0, 300)}\n`);
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
