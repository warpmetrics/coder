// GitHub PR + review operations.
// Wraps `gh` CLI commands for PR lifecycle, reviews, and discovery.

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

export function create({ reviewToken } = {}) {
  let prCache = new Map();

  return {
    async createPR(dir, { title, body, base, head }) {
      const args = ['pr', 'create', '--title', title, '--body-file', '-'];
      if (base) args.push('--base', base);
      if (head) args.push('--head', head);
      const out = await gh(args, { cwd: dir, input: body });
      const lines = out.split('\n');
      const url = lines[lines.length - 1];
      const match = url.match(/\/pull\/(\d+)/);
      if (!match) throw new Error(`Could not extract PR number from gh output: ${out.slice(0, 200)}`);
      return { url, number: parseInt(match[1], 10) };
    },

    async mergePR(prNumber, { repo }) {
      await gh(['pr', 'merge', String(prNumber), '--squash', '--delete-branch', '--repo', repo]);
    },

    async getPRState(prNumber, { repo }) {
      return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state', '--jq', '.state']);
    },

    async getPRBranch(prNumber, { repo }) {
      return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefName', '--jq', '.headRefName']);
    },

    async getPRBody(prNumber, { repo }) {
      return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body', '--jq', '.body']);
    },

    async updatePRBody(prNumber, { repo, body }) {
      await gh(['pr', 'edit', String(prNumber), '--repo', repo, '--body-file', '-'], { input: body });
    },

    async getPRFiles(prNumber, { repo }) {
      const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'files', '--jq', '.files']);
      try { return JSON.parse(out); } catch { return []; }
    },

    async getPRCommits(prNumber, { repo }) {
      const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'commits', '--jq', '.commits']);
      try { return JSON.parse(out); } catch { return []; }
    },

    async getReviews(prNumber, { repo }) {
      const out = await gh(['api', `repos/${repo}/pulls/${prNumber}/reviews`]);
      try { return JSON.parse(out); } catch { return []; }
    },

    async getReviewComments(prNumber, { repo }) {
      const out = await gh(['api', `repos/${repo}/pulls/${prNumber}/comments`]);
      try { return JSON.parse(out); } catch { return []; }
    },

    async submitReview(prNumber, { repo, body, event, comments }) {
      const endpoint = `repos/${repo}/pulls/${prNumber}/reviews`;
      const args = ['api', endpoint, '-X', 'POST', '--input', '-'];
      const env = reviewToken ? { ...process.env, GH_TOKEN: reviewToken } : undefined;
      const effectiveEvent = reviewToken ? event : 'COMMENT';
      const effectiveBody = reviewToken ? body : `**${event === 'APPROVE' ? 'Approved' : 'Changes requested'}**\n\n${body}`;

      if (comments?.length) {
        try {
          await gh(args, { input: JSON.stringify({ event: effectiveEvent, body: effectiveBody, comments }), env });
          return;
        } catch (err) {
          if (!err.message?.includes('422')) throw err;
        }
      }

      await gh(args, { input: JSON.stringify({ event: effectiveEvent, body: effectiveBody }), env });
    },

    async getPRDiff(prNumber, { repo }) {
      return gh(['pr', 'diff', String(prNumber), '--repo', repo]);
    },

    async dismissReview(prNumber, reviewId, { repo, message }) {
      await gh(['api', `repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, '-X', 'PUT', '-f', `message=${message}`]);
    },

    async findLinkedPRs({ repo, issueId, branchPattern }) {
      const cacheKey = `${repo}:${issueId}`;
      if (prCache.has(cacheKey)) return prCache.get(cacheKey);

      const results = [];
      const branch = branchPattern || (typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`);

      try {
        const out = await gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number']);
        if (out) {
          for (const line of out.split('\n')) {
            const n = parseInt(line, 10);
            if (n) results.push(n);
          }
        }
      } catch {}

      if (results.length === 0) {
        try {
          const out = await gh(['pr', 'list', '--repo', repo, '--search', `Closes #${issueId}`, '--json', 'number', '--jq', '.[].number']);
          if (out) {
            for (const line of out.split('\n')) {
              const n = parseInt(line, 10);
              if (n && !results.includes(n)) results.push(n);
            }
          }
        } catch {}
        try {
          const out = await gh(['pr', 'list', '--repo', repo, '--search', `Part of #${issueId}`, '--json', 'number', '--jq', '.[].number']);
          if (out) {
            for (const line of out.split('\n')) {
              const n = parseInt(line, 10);
              if (n && !results.includes(n)) results.push(n);
            }
          }
        } catch {}
      }

      prCache.set(cacheKey, results);
      return results;
    },

    async findAllPRs(issueId, repoNames, { branchPattern } = {}) {
      const all = [];
      for (const repo of repoNames) {
        const prs = await this.findLinkedPRs({ repo, issueId, branchPattern });
        for (const prNumber of prs) {
          all.push({ repo, prNumber });
        }
      }
      return all;
    },

    async classifyReviewItems(items, repoNames) {
      const needsRevision = [];
      const approved = [];

      for (const item of items) {
        const issueId = item._issueId;
        if (!issueId) continue;

        const branchPattern = typeof issueId === 'number'
          ? `agent/issue-${issueId}`
          : `agent/${issueId}`;

        const prs = await this.findAllPRs(issueId, repoNames, { branchPattern });
        if (prs.length === 0) continue;

        item._prs = prs;
        item._prNumber = prs[0].prNumber;

        let allApproved = true;
        let hasReviewFeedback = false;
        let latestActId = null;

        for (const { repo, prNumber } of prs) {
          try {
            const reviews = await this.getReviews(prNumber, { repo }) || [];
            if (reviews.length === 0) continue;

            const actMatch = reviews
              .slice().reverse()
              .map(r => (r.body || '').match(/<!-- wm:act:(wm_act_\w+) -->/))
              .find(m => m);
            if (actMatch && !latestActId) latestActId = actMatch[1];

            const hasApproval = reviews.some(r => r.state === 'APPROVED');
            const hasFeedback = reviews.some(r => r.state === 'CHANGES_REQUESTED');

            if (!hasApproval) allApproved = false;
            if (hasFeedback) hasReviewFeedback = true;
          } catch {
            allApproved = false;
          }
        }

        if (latestActId) item._reviewActId = latestActId;

        if (allApproved && prs.length > 0) {
          approved.push(item);
        } else if (hasReviewFeedback) {
          needsRevision.push(item);
        }
      }

      return { needsRevision, approved };
    },

    clearCache() {
      prCache = new Map();
    },
  };
}
