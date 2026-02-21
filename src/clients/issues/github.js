// GitHub issue operations.
// Wraps `gh` CLI commands for issue body, comments, and labels.

import { execFileSync } from 'child_process';

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

export function create() {
  return {
    getIssueBody(issueId, { repo }) {
      return gh(['issue', 'view', String(issueId), '--repo', repo, '--json', 'body', '--jq', '.body']);
    },

    getIssueComments(issueId, { repo }) {
      const out = gh(['api', `repos/${repo}/issues/${issueId}/comments`, '--paginate']);
      try { return JSON.parse(out); } catch { return []; }
    },

    commentOnIssue(issueId, { repo, body }) {
      gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
    },

    addLabels(issueId, labels, { repo }) {
      for (const label of labels) {
        try { gh(['label', 'create', label, '--repo', repo, '--color', '0E8A16', '--force']); } catch {}
      }
      gh(['issue', 'edit', String(issueId), '--repo', repo, ...labels.flatMap(l => ['--add-label', l])]);
    },
  };
}
