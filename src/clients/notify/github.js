// GitHub notification channel — posts comments on issues via `gh`.

import { execAsync } from '../exec.js';
import { TIMEOUTS } from '../../defaults.js';

export function create({ token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : undefined;

  async function gh(args, opts = {}) {
    try {
      const out = await execAsync('gh', args, { timeout: TIMEOUTS.GH, env, ...opts });
      return out.trim();
    } catch (err) {
      const stderr = err.stderr?.toString().trim();
      const msg = stderr || err.message?.split('\n')[0] || 'gh command failed';
      throw new Error(msg);
    }
  }

  return {
    async comment(issueId, { body, repo }) {
      await gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
    },
  };
}
