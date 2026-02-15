// Apply review feedback on an existing PR.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import * as git from './git.js';
import * as claude from './claude.js';
import * as warp from './warp.js';
import { runHook } from './hooks.js';
import { loadMemory } from './memory.js';
import { reflect } from './reflect.js';

const CONFIG_DIR = '.warp-coder';

export async function revise(item, { board, config, log, refActId }) {
  const prNumber = item._prNumber || item.content?.number;
  const repo = config.repo;
  const repoName = repo.replace(/\.git$/, '').replace(/^.*github\.com[:\/]/, '');
  const maxRevisions = config.maxRevisions || 3;
  const workdir = join(tmpdir(), 'warp-coder', `revise-${prNumber}`);
  const configDir = join(process.cwd(), CONFIG_DIR);

  // Pre-generate act ID for chaining (update PR body so warp-review can link next review)
  const actId = config.warpmetricsApiKey ? warp.generateId('act') : null;

  log(`Revising PR #${prNumber}`);

  // Move to In Progress
  try {
    await board.moveToInProgress(item);
    log('  moved to In Progress');
  } catch (err) {
    log(`  warning: could not move to In Progress: ${err.message}`);
  }

  // Check revision limit
  if (config.warpmetricsApiKey) {
    try {
      const count = await warp.countRevisions(config.warpmetricsApiKey, { prNumber, repo: repoName });
      if (count >= maxRevisions) {
        log(`  revision limit reached (${count}/${maxRevisions}) — moving to Blocked`);
        try { await board.moveToBlocked(item); } catch {}
        return false;
      }
      log(`  revision ${count + 1}/${maxRevisions}`);
    } catch (err) {
      log(`  warning: revision check failed: ${err.message}`);
    }
  }

  // WarpMetrics: start pipeline
  let runId = null;
  let groupId = null;
  if (config.warpmetricsApiKey) {
    try {
      const pipeline = await warp.startPipeline(config.warpmetricsApiKey, {
        step: 'revise',
        repo: repoName,
        prNumber,
        refActId,
      });
      runId = pipeline.runId;
      groupId = pipeline.groupId;
      log(`  pipeline: run=${runId} group=${groupId}`);
    } catch (err) {
      log(`  warning: pipeline start failed: ${err.message}`);
    }
  }

  let success = false;
  let claudeResult = null;
  let taskError = null;
  let reviewComments = [];
  const hookOutputs = [];

  try {
    // Clone + checkout PR branch
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    const branch = git.getPRBranch(prNumber, { repo: repoName });
    log(`  cloning into ${workdir} (branch: ${branch})`);
    git.cloneRepo(repo, workdir, { branch });

    // Fetch review comments for context
    let inlineComments = [];
    try {
      reviewComments = git.getReviews(prNumber, { repo: repoName });
    } catch (err) {
      log(`  warning: could not fetch reviews: ${err.message}`);
    }
    try {
      inlineComments = git.getReviewComments(prNumber, { repo: repoName });
    } catch (err) {
      log(`  warning: could not fetch inline comments: ${err.message}`);
    }

    // Load memory for prompt enrichment
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';

    // Build review feedback section (truncate to ~20k chars to stay within context)
    const maxReviewChars = 20000;
    let reviewSection = '';

    for (const r of reviewComments) {
      const body = (r.body || '').trim();
      if (!body) continue;
      const user = r.user?.login || 'unknown';
      reviewSection += `**${user}** (${r.state || 'COMMENT'}):\n${body}\n\n`;
    }

    if (inlineComments.length > 0) {
      reviewSection += '### Inline comments\n\n';
      for (const c of inlineComments) {
        const user = c.user?.login || 'unknown';
        const body = (c.body || '').trim();
        if (!body) continue;
        const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\`` : '';
        reviewSection += `${location} — **${user}**:\n${body}\n\n`;
      }
    }

    if (reviewSection.length > maxReviewChars) {
      reviewSection = reviewSection.slice(0, maxReviewChars) + '\n\n(Review truncated — focus on the comments shown above.)\n';
    }

    // Claude
    const promptParts = [
      `You are working on PR #${prNumber} in ${repoName}.`,
      '',
    ];

    if (memory) {
      promptParts.push(
        'Lessons learned from previous tasks in this repository:',
        '',
        memory,
        '',
      );
    }

    if (reviewSection) {
      promptParts.push('A code review has been submitted. Here is the feedback:');
      promptParts.push('');
      promptParts.push(reviewSection);
    } else {
      promptParts.push('A code review has been submitted but no comments could be fetched — check the PR manually.');
      promptParts.push('');
    }
    promptParts.push(
      'Your job:',
      '',
      '1. Apply the suggested fixes',
      '2. Run tests to make sure everything passes',
      '3. Commit all changes with a message like "Address review feedback" — this is critical, do not skip the commit',
      '',
      'Do NOT open a new PR — just implement the fixes and commit.',
    );

    const prompt = promptParts.join('\n');

    log('  running claude...');
    claudeResult = await claude.run({
      prompt,
      workdir,
      allowedTools: config.claude?.allowedTools,
      maxTurns: config.claude?.maxTurns,
    });
    log(`  claude done (cost: $${claudeResult.costUsd ?? '?'})`);

    // Hook: onBeforePush
    try {
      const h = runHook('onBeforePush', config, { workdir, prNumber, branch, repo: repoName });
      if (h.ran) hookOutputs.push(h);
    } catch (err) {
      if (err.hookResult) hookOutputs.push(err.hookResult);
      throw err;
    }

    // Auto-commit if Claude left uncommitted changes
    if (git.status(workdir)) {
      log('  claude forgot to commit — auto-committing');
      git.commitAll(workdir, 'Address review feedback');
    }

    // Push
    log('  pushing...');
    git.push(workdir, branch);

    // Update PR body with new act ID for next review cycle
    if (actId) {
      try {
        let body = git.getPRBody(prNumber, { repo: repoName });
        body = body.replace(/<!-- wm:act:wm_act_\w+ -->/, `<!-- wm:act:${actId} -->`);
        if (!body.includes(`<!-- wm:act:${actId} -->`)) {
          body += `\n\n<!-- wm:act:${actId} -->`;
        }
        git.updatePRBody(prNumber, { repo: repoName, body });
      } catch (err) {
        log(`  warning: could not update PR body with act ID: ${err.message}`);
      }
    }

    // Move back to In Review
    try {
      await board.moveToReview(item);
    } catch (err) {
      log(`  warning: could not move to In Review: ${err.message}`);
    }

    success = true;
  } catch (err) {
    taskError = err.message;
    log(`  failed: ${err.message}`);
    try {
      await board.moveToBlocked(item);
    } catch (moveErr) {
      log(`  warning: could not move to Blocked: ${moveErr.message}`);
    }
  } finally {
    // WarpMetrics: record outcome
    if (config.warpmetricsApiKey && groupId) {
      try {
        const outcome = await warp.recordOutcome(config.warpmetricsApiKey, { runId, groupId }, {
          step: 'revise',
          success,
          costUsd: claudeResult?.costUsd,
          error: taskError,
          hooksFailed: hookOutputs.some(h => h.exitCode !== 0),
          prNumber,
          reviewCommentCount: reviewComments.length,
        });
        log(`  outcome: ${outcome.name}`);

        // Emit act so warp-review can link its next review as a follow-up
        if (success && actId && outcome.runOutcomeId) {
          await warp.emitAct(config.warpmetricsApiKey, {
            outcomeId: outcome.runOutcomeId,
            actId,
            name: 'review',
          });
        }
      } catch (err) {
        log(`  warning: outcome recording failed: ${err.message}`);
      }
    }

    // Reflect
    if (config.memory?.enabled !== false) {
      try {
        await reflect({
          configDir,
          step: 'revise',
          prNumber,
          success,
          error: taskError,
          hookOutputs: hookOutputs.filter(h => h.ran),
          reviewComments,
          claudeOutput: claudeResult?.result,
          maxLines: config.memory?.maxLines || 100,
        });
        log('  reflect: memory updated');
      } catch (err) {
        log(`  warning: reflect failed: ${err.message}`);
      }
    }

    // Cleanup
    rmSync(workdir, { recursive: true, force: true });
  }

  return success;
}
