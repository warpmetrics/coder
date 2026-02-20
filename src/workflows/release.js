// Release workflow — infer deployment plan by resuming the Claude session.

import { execFileSync } from 'child_process';

const DEPLOY_PLAN_PROMPT = `Now determine the deployment plan for the repos you just worked on. For each repo, figure out:
- command: the exact command to deploy/release it in production
- dependsOn: which other repos in this list must deploy/release first

Return ONLY a JSON array, no explanation:
[{"repo":"org/name","command":"npm run deploy:prod","dependsOn":[]}]`;

/**
 * Infer a deployment plan by resuming an existing Claude session.
 * Claude already knows the repos and changes from the implement step.
 *
 * @param {string} sessionId - Claude session ID to resume
 * @param {string} workdir - Working directory for the Claude process
 * @param {{ model?: string }} opts
 * @returns {{ releaseSteps: Array, releaseDAG: Object }} or null on failure
 */
export function inferDeployPlan(sessionId, workdir, { model = 'sonnet' } = {}) {
  if (!sessionId) return null;

  let match;
  for (let attempt = 0; attempt < 3; attempt++) {
    let output;
    try {
      output = execFileSync('claude', [
        '-p', DEPLOY_PLAN_PROMPT, '--resume', sessionId,
        '--max-turns', '5', '--model', model,
      ], { encoding: 'utf-8', cwd: workdir, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      if (attempt < 2) continue;
      throw new Error(`claude call failed: ${err.message}`);
    }

    match = output.match(/\[[\s\S]*?\]/);
    if (match) break;
    if (attempt === 2) throw new Error(`no JSON array in response: ${output.slice(0, 200)}`);
  }

  const steps = JSON.parse(match[0]);

  return {
    releaseSteps: steps.map(s => ({
      repo: s.repo, script: s.command,
    })),
    releaseDAG: Object.fromEntries(steps.map(s => [s.repo, s.dependsOn || []])),
  };
}
