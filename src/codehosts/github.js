// GitHub CodeHost adapter.
// Wraps git and gh CLI commands into the CodeHost interface.

import { execFileSync } from 'child_process';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function ghJson(args) {
  const out = gh(args);
  return out ? JSON.parse(out) : null;
}

export function create({ reviewToken } = {}) {

  // Cache: "repo:issueId" → prNumber[]
  let prCache = new Map();

  return {
    // --- Git operations ---

    clone(repoUrl, dest, { branch } = {}) {
      git(['clone', ...(branch ? ['--branch', branch] : []), repoUrl, dest]);
    },

    createBranch(dir, name) {
      git(['checkout', '-b', name], { cwd: dir });
    },

    getHead(dir) {
      return git(['rev-parse', 'HEAD'], { cwd: dir });
    },

    hasNewCommits(dir) {
      const count = git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: dir });
      return parseInt(count, 10) > 0;
    },

    status(dir) {
      return git(['status', '--short'], { cwd: dir });
    },

    commitAll(dir, message, { allowEmpty = false } = {}) {
      git(['add', '-A'], { cwd: dir });
      git(['commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], { cwd: dir });
    },

    push(dir, branch) {
      git(['push', '-u', '--force-with-lease', 'origin', branch], { cwd: dir });
    },

    getCurrentBranch(dir) {
      return git(['branch', '--show-current'], { cwd: dir });
    },

    // --- PR operations ---

    createPR(dir, { title, body, base, head }) {
      const args = ['pr', 'create', '--title', title, '--body-file', '-'];
      if (base) args.push('--base', base);
      if (head) args.push('--head', head);
      const out = gh(args, { cwd: dir, input: body });
      const lines = out.split('\n');
      const url = lines[lines.length - 1];
      const match = url.match(/\/pull\/(\d+)/);
      return { url, number: match ? parseInt(match[1], 10) : null };
    },

    mergePR(prNumber, { repo }) {
      gh(['pr', 'merge', String(prNumber), '--squash', '--delete-branch', '--repo', repo]);
    },

    getPRState(prNumber, { repo }) {
      return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state', '--jq', '.state']);
    },

    getPRBranch(prNumber, { repo }) {
      return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefName', '--jq', '.headRefName']);
    },

    getPRBody(prNumber, { repo }) {
      return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body', '--jq', '.body']);
    },

    updatePRBody(prNumber, { repo, body }) {
      gh(['pr', 'edit', String(prNumber), '--repo', repo, '--body-file', '-'], { input: body });
    },

    getPRFiles(prNumber, { repo }) {
      const out = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'files', '--jq', '.files']);
      return JSON.parse(out);
    },

    getPRCommits(prNumber, { repo }) {
      const out = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'commits', '--jq', '.commits']);
      return JSON.parse(out);
    },

    // --- Review operations ---

    getReviews(prNumber, { repo }) {
      const out = gh(['api', `repos/${repo}/pulls/${prNumber}/reviews`]);
      return JSON.parse(out);
    },

    getReviewComments(prNumber, { repo }) {
      const out = gh(['api', `repos/${repo}/pulls/${prNumber}/comments`]);
      return JSON.parse(out);
    },

    submitReview(prNumber, { repo, body, event, comments }) {
      const endpoint = `repos/${repo}/pulls/${prNumber}/reviews`;
      const args = ['api', endpoint, '-X', 'POST', '--input', '-'];
      const env = reviewToken ? { ...process.env, GH_TOKEN: reviewToken } : undefined;
      // Without a separate review token, APPROVE/REQUEST_CHANGES fails on own PRs.
      const effectiveEvent = reviewToken ? event : 'COMMENT';
      const effectiveBody = reviewToken ? body : `**${event === 'APPROVE' ? 'Approved' : 'Changes requested'}**\n\n${body}`;

      // Try with inline comments first, fall back to body-only if comments cause a 422.
      if (comments?.length) {
        try {
          gh(args, { input: JSON.stringify({ event: effectiveEvent, body: effectiveBody, comments }), env });
          return;
        } catch (err) {
          if (!err.message?.includes('422')) throw err;
          // 422 with comments — likely invalid line numbers; retry without.
        }
      }

      gh(args, { input: JSON.stringify({ event: effectiveEvent, body: effectiveBody }), env });
    },

    getPRDiff(prNumber, { repo }) {
      return gh(['pr', 'diff', String(prNumber), '--repo', repo]);
    },

    getIssueBody(issueId, { repo }) {
      return gh(['issue', 'view', String(issueId), '--repo', repo, '--json', 'body', '--jq', '.body']);
    },

    dismissReview(prNumber, reviewId, { repo, message }) {
      gh(['api', `repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, '-X', 'PUT', '-f', `message=${message}`]);
    },

    // --- Issue/comment operations ---

    getIssueComments(issueId, { repo }) {
      const out = gh(['api', `repos/${repo}/issues/${issueId}/comments`, '--paginate']);
      return JSON.parse(out);
    },

    commentOnIssue(issueId, { repo, body }) {
      gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
    },

    botComment(issueId, { repo, body, runId }) {
      const header = runId
        ? `**warp-coder** · [run](https://warpmetrics.com/app/runs/${runId})`
        : '**warp-coder**';
      const formatted = `${header}\n\n---\n\n${body}`;
      gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: formatted });
    },

    // --- PR discovery ---

    findLinkedPRs({ repo, issueId, branchPattern }) {
      const cacheKey = `${repo}:${issueId}`;
      if (prCache.has(cacheKey)) return prCache.get(cacheKey);

      const results = [];
      const branch = branchPattern || (typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`);

      try {
        const out = gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number']);
        if (out) {
          for (const line of out.split('\n')) {
            const n = parseInt(line, 10);
            if (n) results.push(n);
          }
        }
      } catch {}

      if (results.length === 0) {
        try {
          const out = gh(['pr', 'list', '--repo', repo, '--search', `Closes #${issueId}`, '--json', 'number', '--jq', '.[].number']);
          if (out) {
            for (const line of out.split('\n')) {
              const n = parseInt(line, 10);
              if (n && !results.includes(n)) results.push(n);
            }
          }
        } catch {}
        try {
          const out = gh(['pr', 'list', '--repo', repo, '--search', `Part of #${issueId}`, '--json', 'number', '--jq', '.[].number']);
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

    findAllPRs(issueId, repoNames, { branchPattern } = {}) {
      const all = [];
      for (const repo of repoNames) {
        const prs = this.findLinkedPRs({ repo, issueId, branchPattern });
        for (const prNumber of prs) {
          all.push({ repo, prNumber });
        }
      }
      return all;
    },

    classifyReviewItems(items, repoNames) {
      const needsRevision = [];
      const approved = [];

      for (const item of items) {
        const issueId = item._issueId;
        if (!issueId) continue;

        const branchPattern = typeof issueId === 'number'
          ? `agent/issue-${issueId}`
          : `agent/${issueId}`;

        const prs = this.findAllPRs(issueId, repoNames, { branchPattern });
        if (prs.length === 0) continue;

        item._prs = prs;
        item._prNumber = prs[0].prNumber;

        let allApproved = true;
        let hasReviewFeedback = false;
        let latestActId = null;

        for (const { repo, prNumber } of prs) {
          try {
            const reviews = ghJson(['api', `repos/${repo}/pulls/${prNumber}/reviews`]);
            if (!reviews) continue;

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
