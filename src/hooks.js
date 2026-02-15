import { execSync } from 'child_process';

export function runHook(name, config, context) {
  const cmd = config.hooks?.[name];
  if (!cmd) return { ran: false };

  console.log(`  hook: ${name} → ${cmd}`);

  const env = { ...process.env };
  if (context.issueNumber) env.ISSUE_NUMBER = String(context.issueNumber);
  if (context.prNumber) env.PR_NUMBER = String(context.prNumber);
  if (context.branch) env.BRANCH = context.branch;
  if (context.repo) env.REPO = context.repo;

  try {
    const stdout = execSync(cmd, { cwd: context.workdir, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ran: true, hook: name, stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const result = { ran: true, hook: name, stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
    // Re-throw with the captured output attached so callers still get the error
    const wrapped = new Error(`Hook "${name}" failed (exit ${result.exitCode}): ${(err.stderr || err.message).slice(0, 200)}`);
    wrapped.hookResult = result;
    throw wrapped;
  }
}
