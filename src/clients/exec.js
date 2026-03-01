// Async subprocess execution. Replaces all execFileSync usage to avoid
// blocking the event loop (critical for TUI responsiveness).

import { spawn } from 'child_process';

export function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { input, timeout, ...spawnOpts } = opts;
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOpts,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    if (input != null) {
      proc.stdin.write(input);
    }
    proc.stdin.end();

    let timedOut = false;
    let timer = null;
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`Timed out after ${timeout}ms`);
        err.stderr = stderr;
        reject(err);
      } else if (code !== 0) {
        const err = new Error(stderr.trim() || `Exit code ${code}`);
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = code;
        reject(err);
      } else {
        resolve(stdout);
      }
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
