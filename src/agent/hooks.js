import { execSync } from 'child_process';
import { TIMEOUTS } from '../defaults.js';

export function runHook(name, config, context) {
  const cmd = config.hooks?.[name];
  if (!cmd) return { ran: false };

  const env = { ...process.env };
  if (context.issueNumber) env.ISSUE_NUMBER = String(context.issueNumber);
  if (context.prNumber) env.PR_NUMBER = String(context.prNumber);
  if (context.branch) env.BRANCH = context.branch;
  if (context.repo) env.REPO = context.repo;

  const timeout = config.hooks?.timeout ? config.hooks.timeout * 1000 : TIMEOUTS.HOOK;

  try {
    const stdout = execSync(cmd, { cwd: context.workdir, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout });
    return { ran: true, hook: name, stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const result = { ran: true, hook: name, stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
    const wrapped = new Error(`Hook "${name}" failed (exit ${result.exitCode}): ${(err.stderr || err.message).slice(0, 200)}`);
    wrapped.hookResult = result;
    throw wrapped;
  }
}

export function safeHook(name, config, context, hookOutputs) {
  try {
    const h = runHook(name, config, context);
    if (h.ran) hookOutputs.push(h);
  } catch (err) {
    if (err.hookResult) hookOutputs.push(err.hookResult);
    throw err;
  }
}
