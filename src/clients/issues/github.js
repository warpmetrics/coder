// GitHub issue operations.
// Wraps `gh` CLI commands for issue body, comments, and labels.

import { execAsync } from '../exec.js';
import { TIMEOUTS } from '../../defaults.js';

async function gh(args, opts = {}) {
  try {
    const out = await execAsync('gh', args, { timeout: TIMEOUTS.GH, ...opts });
    return out.trim();
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    const msg = stderr || err.message?.split('\n')[0] || 'gh command failed';
    throw new Error(msg);
  }
}

export function create() {
  return {
    async getIssueBody(issueId, { repo }) {
      return gh(['issue', 'view', String(issueId), '--repo', repo, '--json', 'body', '--jq', '.body']);
    },

    async getIssueComments(issueId, { repo }) {
      const out = await gh(['api', `repos/${repo}/issues/${issueId}/comments`, '--paginate']);
      try { return JSON.parse(out); } catch { return []; }
    },

    async commentOnIssue(issueId, { repo, body }) {
      await gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
    },

    async addLabels(issueId, labels, { repo }) {
      for (const label of labels) {
        try { await gh(['label', 'create', label, '--repo', repo, '--color', '0E8A16', '--force']); } catch {}
      }
      await gh(['issue', 'edit', String(issueId), '--repo', repo, ...labels.flatMap(l => ['--add-label', l])]);
    },

    async closeIssue(issueId, { repo, reason } = {}) {
      const args = ['issue', 'close', String(issueId), '--repo', repo];
      if (reason) args.push('--reason', reason);
      await gh(args);
    },

    async addReaction(commentId, reaction, { repo }) {
      await gh(['api', `repos/${repo}/issues/comments/${commentId}/reactions`,
        '-X', 'POST', '-f', `content=${reaction}`]);
    },
  };
}
