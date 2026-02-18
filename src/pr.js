// PR discovery and review classification.
// Board-agnostic — works for both GitHub Projects and Linear.
// All GitHub API calls go through `gh` CLI.

import { execFileSync } from 'child_process';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function ghJson(args) {
  const out = gh(args);
  return out ? JSON.parse(out) : null;
}

// Cache: "repo:issueId" → prNumber[]
let prCache = new Map();

/**
 * Find PRs linked to an issue in a single repo.
 * Returns array of PR numbers (may be empty).
 */
export function findLinkedPRs({ repo, issueId, branchPattern }) {
  const cacheKey = `${repo}:${issueId}`;
  if (prCache.has(cacheKey)) return prCache.get(cacheKey);

  const results = [];
  const branch = branchPattern || (typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`);

  // Try branch-based lookup first
  try {
    const out = gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number']);
    if (out) {
      for (const line of out.split('\n')) {
        const n = parseInt(line, 10);
        if (n) results.push(n);
      }
    }
  } catch {}

  // Fallback: search by "Closes #N" or "Part of" in body
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
}

/**
 * Search all repos for PRs matching an issue.
 * Returns array of { repo, prNumber } objects.
 */
export function findAllPRs(issueId, repoNames, { branchPattern } = {}) {
  const all = [];
  for (const repo of repoNames) {
    const prs = findLinkedPRs({ repo, issueId, branchPattern });
    for (const prNumber of prs) {
      all.push({ repo, prNumber });
    }
  }
  return all;
}

/**
 * Classify review items by fetching reviews for each item's PRs.
 * Multi-repo: approved only if ALL PRs are approved.
 *
 * @param {Array} items - board items with _issueId set
 * @param {string[]} repoNames - repos to search for PRs
 * @returns {{ needsRevision: Array, approved: Array }}
 */
export function classifyReviewItems(items, repoNames) {
  const needsRevision = [];
  const approved = [];

  for (const item of items) {
    const issueId = item._issueId;
    if (!issueId) continue;

    const branchPattern = typeof issueId === 'number'
      ? `agent/issue-${issueId}`
      : `agent/${issueId}`;

    const prs = findAllPRs(issueId, repoNames, { branchPattern });
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

        // Parse act ID from the most recent warp-review review body
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
}

/**
 * Clear cache — call at the start of each poll cycle.
 */
export function clearCache() {
  prCache = new Map();
}
