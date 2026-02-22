// Review executor: spawns Claude to review a PR with full codebase context.
// Returns typed results — no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from '../../config.js';
import { LIMITS } from '../../defaults.js';
import { fetchComments } from '../../clients/claude-code.js';
import { buildReviewPrompt, REVIEW_SCHEMA, ReviewVerdictSchema } from './prompt.js';
import { installSkills } from '../../agent/skills.js';

export const definition = {
  name: 'review',
  resultTypes: ['approved', 'changes_requested', 'error', 'max_retries'],
  create() {
    return async (run, ctx) => {
      const { config, clients, context } = ctx;
      const item = run.boardItem || { _issueId: run.issueId, content: { title: run.title } };
      const r = await review(item, { config, clients, context });

      if (r.type === 'approved' || r.type === 'changes_requested') {
        const outcomeOpts = { prNumber: r.prNumber, reviewCommentCount: r.commentCount };
        if (r.parseFailed) { outcomeOpts.parseFailed = true; outcomeOpts.claudeOutput = r.claudeOutput; }
        return { ...r, outcomeOpts,
          nextActOpts: { prs: r.prs, release: context.actOpts?.release, sessionId: context.actOpts?.sessionId } };
      }
      if (r.type === 'error') {
        const retryCount = (context.actOpts?.reviewRetryCount || 0) + 1;
        const limit = config.claude?.reviewMaxRetries || LIMITS.MAX_REVIEW_RETRIES;
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
  const { config, clients: { git, prs, issues, claudeCode, log }, context: { onStep, onBeforeLog } } = ctx;
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

    // 3. Skills + issue context
    const configDir = join(process.cwd(), CONFIG_DIR);
    const skillCount = installSkills(configDir, workdir);
    if (skillCount) log(`  installed ${skillCount} skill(s)`);

    let issueBody = '';
    try {
      issueBody = issues.getIssueBody(issueId, { repo: primaryRepo });
    } catch (err) { log(`  warning: getIssueBody failed: ${err.message}`); }

    const { commentsText } = fetchComments(issues, issueId, primaryRepo, log);

    // 4. Review: let Claude explore the diff and produce a JSON verdict
    onStep?.('reviewing');
    const prompt = buildReviewPrompt({
      workdir, repoDirs, issueId, issueTitle, issueBody, commentsText,
    });

    const maxTurns = config.claude?.reviewMaxTurns || LIMITS.MAX_REVIEW_TURNS;
    const result = await claudeCode.run({
      prompt, workdir, maxTurns,
      jsonSchema: REVIEW_SCHEMA,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash(gh *)'],
      logPrefix: `[#${issueId}] [review]`, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);

    // 5. Parse JSON verdict from output
    let raw = result.structuredOutput;
    if (!raw) {
      try { raw = JSON.parse(result.result); } catch { raw = extractReviewJson(result.result); }
    }

    let parseFailed = false;
    const parsed = raw ? ReviewVerdictSchema.safeParse(raw) : null;
    let reviewData;
    if (parsed?.success) {
      reviewData = parsed.data;
    } else {
      parseFailed = true;
      log('  warning: could not parse verdict JSON, using conservative fallback');
      reviewData = {
        verdict: 'request_changes',
        summary: 'Could not produce structured verdict. Manual review recommended.',
        comments: [],
      };
    }

    const verdict = reviewData.verdict === 'request_changes' ? 'request_changes' : 'approve';
    const event = verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
    const comments = (reviewData.comments || []).map(c => ({
      path: c.path,
      ...(c.line != null ? { line: c.line } : {}),
      body: c.body,
    })).filter(c => c.path && c.body);

    // 6. Submit review on each PR
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

    // 7. Return result
    const prNumber = repoDirs[0]?.prNumber;
    const commentCount = comments.length;
    const resultPrs = repoDirs.map(r => ({ repo: r.name, prNumber: r.prNumber }));
    const base = { costUsd: result.costUsd, trace: result.trace, prNumber, commentCount, prs: resultPrs };
    if (parseFailed) {
      base.parseFailed = true;
      base.claudeOutput = result.result || '';
    }
    if (verdict === 'approve') {
      return { type: 'approved', ...base };
    } else {
      return { type: 'changes_requested', ...base };
    }
  } catch (err) {
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  }
}

// Fallback: extract JSON from text when structured_output is not available.
// The verdict JSON may contain embedded markdown code fences (e.g. ```js
// inside comment bodies), so we can't rely on lazy regex to find the closing
// fence. Instead we find the opening { after the last ```json marker and
// use brace-depth matching to extract the complete JSON object.
export function extractReviewJson(text) {
  if (!text) return null;

  // Find the start of the JSON object — prefer last ```json fence, fall back to last {
  let searchFrom = 0;
  const lastFence = text.lastIndexOf('```json');
  if (lastFence !== -1) searchFrom = lastFence;

  const braceStart = text.indexOf('{', searchFrom);
  if (braceStart === -1) return null;

  const rest = text.slice(braceStart);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(rest.slice(0, i + 1)); } catch { return null; } } }
  }

  return null;
}
