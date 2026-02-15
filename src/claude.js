import { spawn } from 'child_process';

export function run({ prompt, workdir, allowedTools = 'Bash,Read,Edit,Write,Glob,Grep', maxTurns, verbose = true }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', allowedTools,
      '--dangerously-skip-permissions',
    ];
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

    function flushTools() {
      if (pendingTools.length === 0) return;
      process.stderr.write(`  claude: ${pendingTools.join(', ')}\n`);
      pendingTools = [];
    }

    proc.stdout.on('data', d => {
      stdout += d;
      buffer += d;
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
                  if (text) process.stderr.write(`  claude: ${text.slice(0, 300)}\n`);
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

    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      if (verbose) flushTools();
      if (code !== 0) {
        return reject(new Error(`claude exited with code ${code}: ${stderr}`));
      }
      resolve({
        result: resultEvent?.result ?? lastAssistantText ?? stdout,
        sessionId: resultEvent?.session_id ?? null,
        costUsd: resultEvent?.total_cost_usd ?? null,
      });
    });

    proc.on('error', reject);
  });
}
