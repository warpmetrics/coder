// Review executor: spawns Claude to review a PR with full codebase context.
// Returns typed results — no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { repoName, deriveRepoDirNames } from '../../config.js';
import { fetchComments } from '../claude.js';
import { buildReviewPrompt, REVIEW_SCHEMA } from './prompt.js';

export const definition = {
  name: 'review',
  resultTypes: ['approved', 'changes_requested', 'error', 'max_retries'],
  create() {
    return async (run, ctx) => {
      const { config, clients, context } = ctx;
      const item = run.boardItem || { _issueId: run.issueId, content: { title: run.title } };
      const r = await review(item, { config, clients, context });

      if (r.type === 'approved') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { prs: r.prs, release: context.actOpts?.release, sessionId: context.actOpts?.sessionId } };
      }
      if (r.type === 'changes_requested') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { prs: r.prs, release: context.actOpts?.release, sessionId: context.actOpts?.sessionId } };
      }
      if (r.type === 'error') {
        const retryCount = (context.actOpts?.reviewRetryCount || 0) + 1;
        const limit = config.claude?.reviewMaxRetries || 3;
        if (retryCount >= limit) {
          context.log(`review failed ${retryCount} times, giving up`);
          return { ...r, type: 'max_retries', outcomeOpts: { prNumber: r.prNumber },
            nextActOpts: { prs: r.prs || context.actOpts?.prs, release: context.actOpts?.release, sessionId: context.actOpts?.sessionId } };
        }
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { prs: r.prs || context.actOpts?.prs, release: context.actOpts?.release, sessionId: context.actOpts?.sessionId, reviewRetryCount: retryCount } };
      }
      return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount } };
    };
  },
};

export async function review(item, ctx) {
  const { config, clients: { git, prs, issues, claudeCode }, context: { log, onStep, onBeforeLog } } = ctx;
  const repoNames = config.repoNames;
  const issueId = item._issueId;
  const issueTitle = item.content?.title || `Issue #${issueId}`;
  const repos = config.repos;
  const primaryRepo = repoNames?.[0] || repoName(repos[0]);
  const workdir = join(tmpdir(), 'warp-coder', String(issueId));

  try {
    // 1. Find PRs
    onStep?.('finding PRs');
    const branchPattern = typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`;
    const foundPRs = prs.findAllPRs(issueId, repoNames || repos.map(r => repoName(r)), { branchPattern });
    if (foundPRs.length === 0) {
      log('  no open PRs found');
      return { type: 'error', error: 'No open PRs found', costUsd: null, trace: null };
    }
    log(`  found ${foundPRs.length} PR(s): ${foundPRs.map(p => `${p.repo}#${p.prNumber}`).join(', ')}`);

    // 2. Reuse existing repo dirs or clone as fallback
    onStep?.('cloning');
    const dirNames = deriveRepoDirNames(repos);
    const prLookup = new Map(foundPRs.map(p => [p.repo, p]));
    const repoDirs = [];

    const workdirExists = existsSync(workdir);

    for (let i = 0; i < repos.length; i++) {
      const url = repos[i].url, name = repoName(repos[i]), dirName = dirNames[i], dest = join(workdir, dirName);
      const pr = prLookup.get(name);
      if (pr) {
        if (workdirExists && existsSync(join(dest, '.git'))) {
          // Reuse existing workdir from implement
          const branch = prs.getPRBranch(pr.prNumber, { repo: name });
          repoDirs.push({ url, name, dirName, dir: dest, prNumber: pr.prNumber, branch });
          log(`  reusing ${name} (branch: ${branch})`);
        } else {
          // Fallback: clone fresh
          mkdirSync(workdir, { recursive: true });
          const branch = prs.getPRBranch(pr.prNumber, { repo: name });
          git.clone(url, dest, { branch });
          repoDirs.push({ url, name, dirName, dir: dest, prNumber: pr.prNumber, branch });
          log(`  cloned ${name} (branch: ${branch})`);
        }
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
        const diff = prs.getPRDiff(rd.prNumber, { repo: rd.name });
        diffs.push({ repo: rd.name, prNumber: rd.prNumber, diff });
      } catch (err) {
        log(`  warning: could not get diff for ${rd.name}#${rd.prNumber}: ${err.message}`);
      }
    }

    let issueBody = '';
    try {
      issueBody = issues.getIssueBody(issueId, { repo: primaryRepo });
    } catch {}

    const { commentsText } = fetchComments(issues, issueId, primaryRepo);

    // 4. Build prompt
    const prompt = buildReviewPrompt({
      workdir, repoDirs, diffs, issueId, issueTitle, issueBody, commentsText,
    });

    // 5. Spawn Claude Code with JSON schema for structured output
    onStep?.('reviewing');
    const maxTurns = config.claude?.reviewMaxTurns || 10;
    const result = await claudeCode.run({
      prompt, workdir, maxTurns,
      jsonSchema: REVIEW_SCHEMA,
      logPrefix: `[#${issueId} review] `, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);

    // 6. Parse structured output (falls back to text extraction if structured_output missing)
    const reviewData = result.structuredOutput ?? extractReviewJson(result.result);
    if (!reviewData || !reviewData.verdict) {
      const preview = (result.result || '').slice(-200);
      log(`  error: could not extract review JSON from Claude output (tail: ${preview})`);
      return { type: 'error', error: 'Could not extract review JSON from Claude response', costUsd: result.costUsd, trace: result.trace };
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
        prs.submitReview(rd.prNumber, {
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
  }
}

// Fallback: extract JSON from text when structured_output is not available.
function extractReviewJson(text) {
  if (!text) return null;

  // Try last ```json ... ``` fenced block
  const fenceMatches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (fenceMatches.length > 0) {
    try { return JSON.parse(fenceMatches[fenceMatches.length - 1][1]); } catch {}
  }

  // Try last { ... } block
  const lastBrace = text.lastIndexOf('{');
  if (lastBrace !== -1) {
    const rest = text.slice(lastBrace);
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(rest.slice(0, i + 1)); } catch { break; } } }
    }
  }

  return null;
}
