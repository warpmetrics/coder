// GitHub notification channel — posts comments on issues via `gh`.

import { execFileSync } from 'child_process';

export function create({ token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : undefined;

  function gh(args, opts = {}) {
    return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env, ...opts }).trim();
  }

  return {
    comment(issueId, { body, repo }) {
      gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
    },
  };
}
