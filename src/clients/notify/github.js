// GitHub notification channel — posts comments on issues via `gh`.

import { execFileSync } from 'child_process';

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

export function create() {
  return {
    comment(issueId, { body, repo }) {
      gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
    },
  };
}
