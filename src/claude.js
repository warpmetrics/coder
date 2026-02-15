import { spawn } from 'child_process';

export function run({ prompt, workdir, allowedTools = 'Bash,Read,Edit,Write,Glob,Grep', maxTurns, verbose = true }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', allowedTools];
    if (maxTurns) args.push('--max-turns', String(maxTurns));

    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => {
      stderr += d;
      if (verbose) process.stderr.write(d);
    });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`claude exited with code ${code}: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        resolve({
          result: result.result || result,
          sessionId: result.session_id || null,
          costUsd: result.cost_usd || null,
        });
      } catch {
        // Non-JSON output — still succeeded
        resolve({ result: stdout, sessionId: null, costUsd: null });
      }
    });

    proc.on('error', reject);
  });
}
