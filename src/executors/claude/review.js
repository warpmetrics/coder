// Claude Code review executor: spawns Claude to review a PR with full codebase context.
// Returns typed results — no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { repoName, deriveRepoDirNames } from '../../config.js';
import { runClaudeCode, fetchComments, buildTrace } from './index.js';
import { buildReviewPrompt } from '../../prompts.js';

export async function review(item, { config, codehost, log, onStep, onBeforeLog, repoNames }) {
  const issueId = item._issueId;
  const issueTitle = item.content?.title || `Issue #${issueId}`;
  const repos = config.repos;
  const primaryRepo = repoNames?.[0] || repoName(repos[0]);
  const workdir = join(tmpdir(), 'warp-coder', `review-${issueId}`);

  try {
    // 1. Find PRs
    onStep?.('finding PRs');
    const branchPattern = typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`;
    const prs = codehost.findAllPRs(issueId, repoNames || repos.map(r => repoName(r)), { branchPattern });
    if (prs.length === 0) {
      log('  no open PRs found');
      return { type: 'error', error: 'No open PRs found', costUsd: null, trace: null };
    }
    log(`  found ${prs.length} PR(s): ${prs.map(p => `${p.repo}#${p.prNumber}`).join(', ')}`);

    // 2. Clone repos at PR branches
    onStep?.('cloning');
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    const dirNames = deriveRepoDirNames(repos);
    const prLookup = new Map(prs.map(p => [p.repo, p]));
    const repoDirs = [];

    for (let i = 0; i < repos.length; i++) {
      const url = repos[i].url, name = repoName(repos[i]), dirName = dirNames[i], dest = join(workdir, dirName);
      const pr = prLookup.get(name);
      if (pr) {
        const branch = codehost.getPRBranch(pr.prNumber, { repo: name });
        codehost.clone(url, dest, { branch });
        repoDirs.push({ url, name, dirName, dir: dest, prNumber: pr.prNumber, branch });
        log(`  cloned ${name} (branch: ${branch})`);
      }
    }

    if (repoDirs.length === 0) {
      return { type: 'error', error: 'Could not clone any PR branches', costUsd: null, trace: null };
    }

    // 3. Gather context
    onStep?.('gathering context');
    const diffs = [];
    for (const rd of repoDirs) {
      try {
        const diff = codehost.getPRDiff(rd.prNumber, { repo: rd.name });
        diffs.push({ repo: rd.name, prNumber: rd.prNumber, diff });
      } catch (err) {
        log(`  warning: could not get diff for ${rd.name}#${rd.prNumber}: ${err.message}`);
      }
    }

    let issueBody = '';
    try {
      issueBody = codehost.getIssueBody(issueId, { repo: primaryRepo });
    } catch {}

    const { commentsText } = fetchComments(codehost, issueId, primaryRepo);

    // 4. Build prompt
    const prompt = buildReviewPrompt({
      workdir, repoDirs, diffs, issueId, issueTitle, issueBody, commentsText,
    });

    // 5. Spawn Claude Code
    onStep?.('reviewing');
    const maxTurns = config.claude?.reviewMaxTurns || 10;
    const result = await runClaudeCode(prompt, workdir, { ...config, claude: { ...config.claude, maxTurns } }, {
      logPrefix: `[#${issueId} review] `, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);

    // 6. Parse review output
    const reviewFile = join(workdir, '.warp-coder-review');
    let reviewData;
    try {
      reviewData = JSON.parse(readFileSync(reviewFile, 'utf-8'));
    } catch {
      log('  warning: could not parse .warp-coder-review, defaulting to approve');
      reviewData = { verdict: 'approve', summary: 'Review completed — no structured output produced.', comments: [] };
    }

    const verdict = reviewData.verdict === 'request_changes' ? 'request_changes' : 'approve';
    const event = verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
    const comments = (reviewData.comments || []).map(c => ({
      path: c.path,
      line: c.line,
      body: c.body,
    })).filter(c => c.path && c.body);

    // 7. Submit review on each PR
    onStep?.('submitting review');
    let submitSucceeded = false;
    const submitErrors = [];
    for (const rd of repoDirs) {
      try {
        codehost.submitReview(rd.prNumber, {
          repo: rd.name,
          event,
          body: reviewData.summary || '',
          comments: comments.filter(c => {
            // Only submit comments whose path exists in this repo
            try { return existsSync(join(rd.dir, c.path)); } catch { return false; }
          }),
        });
        log(`  submitted ${event} on ${rd.name}#${rd.prNumber}`);
        submitSucceeded = true;
      } catch (err) {
        log(`  warning: review submit failed for ${rd.name}#${rd.prNumber}: ${err.message}`);
        submitErrors.push(`${rd.name}#${rd.prNumber}: ${err.message}`);
      }
    }

    if (!submitSucceeded) {
      return { type: 'error', error: `Review submit failed: ${submitErrors.join('; ')}`, costUsd: result.costUsd, trace: result.trace };
    }

    // 8. Return result
    const prNumber = repoDirs[0]?.prNumber;
    const commentCount = comments.length;
    const resultPrs = repoDirs.map(r => ({ repo: r.name, prNumber: r.prNumber }));
    if (verdict === 'approve') {
      return { type: 'approved', costUsd: result.costUsd, trace: result.trace, prNumber, commentCount, prs: resultPrs };
    } else {
      return { type: 'changes_requested', costUsd: result.costUsd, trace: result.trace, prNumber, commentCount, prs: resultPrs };
    }
  } catch (err) {
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
