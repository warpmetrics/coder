// Apply review feedback on existing PRs.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from './config.js';
import * as git from './git.js';
import * as claude from './claude.js';
import * as warp from './warp.js';
import { warp as warpInit, trace, flush } from '@warpmetrics/warp';
import { safeHook } from './hooks.js';
import { loadMemory } from './memory.js';
import { reflect } from './reflect.js';

export async function revise(item, { board, config, log, refActId, since, onStep, onBeforeLog }) {
  const issueId = item._issueId;
  const prs = item._prs || [];
  const primaryPR = prs[0];
  const primaryRepoName = primaryPR ? primaryPR.repo : repoName(config.repos[0]);
  const primaryPRNumber = primaryPR?.prNumber || item._prNumber || item.content?.number;
  const repos = config.repos;
  const maxRevisions = config.maxRevisions || 3;
  const workdir = join(tmpdir(), 'warp-coder', `revise-${issueId}`);
  const configDir = join(process.cwd(), CONFIG_DIR);

  // Pre-generate act ID for chaining — only written to primary PR body
  const actId = config.warpmetricsApiKey ? warp.generateId('act') : null;

  log(`Revising ${prs.length} PR(s) for #${issueId}`);

  // Initialize warp SDK for trace() calls
  if (config.warpmetricsApiKey) {
    warpInit(null, { apiKey: config.warpmetricsApiKey });
  }

  // Move to In Progress
  try {
    await board.moveToInProgress(item);
    log('  moved to In Progress');
  } catch (err) {
    log(`  warning: could not move to In Progress: ${err.message}`);
  }

  // Check revision limit (use primary PR)
  if (config.warpmetricsApiKey && primaryPRNumber) {
    try {
      const revisionCount = await warp.countRevisions(config.warpmetricsApiKey, { prNumber: primaryPRNumber, repo: primaryRepoName, since });
      if (revisionCount >= maxRevisions) {
        log(`  revision limit reached (${revisionCount}/${maxRevisions}) — moving to Blocked`);
        try { await board.moveToBlocked(item); } catch {}
        return { success: false, reason: 'max_retries', count: revisionCount };
      }
      log(`  revision ${revisionCount + 1}/${maxRevisions}`);
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
        repo: primaryRepoName,
        prNumber: primaryPRNumber,
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
  let hitMaxTurns = false;
  let allReviewComments = [];
  const hookOutputs = [];

  try {
    // Clone repos
    onStep?.('cloning');
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });

    // Build a lookup: repoName → { prNumber, branch }
    const prLookup = new Map();
    for (const { repo, prNumber } of prs) {
      const branch = git.getPRBranch(prNumber, { repo });
      prLookup.set(repo, { prNumber, branch });
    }

    const dirNames = deriveRepoDirNames(repos);
    const repoDirs = []; // { url, name, dirName, dir, prNumber, branch, hasPR }
    const contextRepos = []; // repos without PRs, available for on-demand cloning
    const headsBefore = new Map(); // dir → HEAD sha

    for (let i = 0; i < repos.length; i++) {
      const repoUrl = repos[i];
      const name = repoName(repoUrl);
      const dirName = dirNames[i];
      const dest = join(workdir, dirName);
      const prInfo = prLookup.get(name);

      if (prInfo) {
        log(`  cloning ${name} (branch: ${prInfo.branch})`);
        git.cloneRepo(repoUrl, dest, { branch: prInfo.branch });
        repoDirs.push({ url: repoUrl, name, dirName, dir: dest, prNumber: prInfo.prNumber, branch: prInfo.branch, hasPR: true });
        headsBefore.set(dest, git.getHead(dest));
      } else {
        // No PR in this repo — don't clone, mention in prompt for on-demand reference
        log(`  skipping ${name} (no PR — available for on-demand reference)`);
        contextRepos.push({ url: repoUrl, name, dirName });
      }
    }

    // Fetch review comments from ALL PRs
    let allInlineComments = [];
    for (const { repo, prNumber } of prs) {
      try {
        const reviews = git.getReviews(prNumber, { repo });
        allReviewComments.push(...reviews.map(r => ({ ...r, _repo: repo, _prNumber: prNumber })));
      } catch (err) {
        log(`  warning: could not fetch reviews for ${repo}#${prNumber}: ${err.message}`);
      }
      try {
        const inline = git.getReviewComments(prNumber, { repo });
        allInlineComments.push(...inline.map(c => ({ ...c, _repo: repo, _prNumber: prNumber })));
      } catch (err) {
        log(`  warning: could not fetch inline comments for ${repo}#${prNumber}: ${err.message}`);
      }
    }

    // Load memory for prompt enrichment
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';

    // Build review feedback section (truncate to ~20k chars to stay within context)
    const maxReviewChars = 20000;
    let reviewSection = '';

    for (const r of allReviewComments) {
      const body = (r.body || '').trim();
      if (!body) continue;
      const user = r.user?.login || 'unknown';
      const prefix = prs.length > 1 ? `[${r._repo}#${r._prNumber}] ` : '';
      reviewSection += `${prefix}**${user}** (${r.state || 'COMMENT'}):\n${body}\n\n`;
    }

    if (allInlineComments.length > 0) {
      reviewSection += '### Inline comments\n\n';
      for (const c of allInlineComments) {
        const user = c.user?.login || 'unknown';
        const body = (c.body || '').trim();
        if (!body) continue;
        const prefix = prs.length > 1 ? `[${c._repo}] ` : '';
        const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\`` : '';
        reviewSection += `${prefix}${location} — **${user}**:\n${body}\n\n`;
      }
    }

    if (reviewSection.length > maxReviewChars) {
      reviewSection = reviewSection.slice(0, maxReviewChars) + '\n\n(Review truncated — focus on the comments shown above.)\n';
    }

    // Build Claude prompt
    const promptParts = [];

    const dirList = repoDirs.map(r => `  - ${r.dirName}/ (${r.name}) — PR #${r.prNumber}`).join('\n');
    promptParts.push(
      `Repos with PRs (already cloned):`,
      dirList,
      '',
    );
    if (contextRepos.length > 0) {
      promptParts.push(
        `Other repos available for reference if needed:`,
        '',
      );
      for (const cr of contextRepos) {
        promptParts.push(`  git clone ${cr.url} ${cr.dirName}`);
      }
      promptParts.push('');
    }

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

    if (repoDirs.length > 1) {
      promptParts.push('Commit separately in each repo that needs changes.');
    }

    const prompt = promptParts.join('\n');

    onStep?.('claude');
    log('  running claude...');
    const claudeStart = Date.now();
    claudeResult = await claude.run({
      prompt,
      workdir,
      allowedTools: config.claude?.allowedTools,
      maxTurns: config.claude?.maxTurns,
      logPrefix: `[#${issueId}] `,
      onBeforeLog,
    });
    const claudeDuration = Date.now() - claudeStart;
    log(`  claude done (cost: $${claudeResult.costUsd ?? '?'})`);

    // Trace the Claude Code call in WarpMetrics
    if (groupId) {
      try {
        trace(groupId, {
          provider: 'anthropic',
          model: 'claude-code',
          duration: claudeDuration,
          startedAt: new Date(claudeStart).toISOString(),
          endedAt: new Date(claudeStart + claudeDuration).toISOString(),
          cost: claudeResult.costUsd,
          status: claudeResult.subtype === 'error_max_turns' ? 'error' : 'success',
          opts: {
            turns: claudeResult.numTurns,
            session_id: claudeResult.sessionId,
          },
        });
        await flush();
      } catch {}
    }

    // Check if Claude hit max turns
    if (claudeResult.subtype === 'error_max_turns') {
      hitMaxTurns = true;
      throw new Error(`Claude reached the maximum number of turns (${claudeResult.numTurns || config.claude?.maxTurns || '?'}) without completing the task`);
    }

    // Hook: onBeforePush
    onStep?.('pushing');
    safeHook('onBeforePush', config, { workdir, prNumber: primaryPRNumber, branch: repoDirs.find(r => r.hasPR)?.branch, repo: primaryRepoName }, hookOutputs);

    // Check each repo with a PR for changes, auto-commit, push
    let anyChanges = false;

    for (const rd of repoDirs) {
      if (!rd.hasPR) continue;

      // Exclude temp files so git add -A doesn't pick them up
      const excludeFile = join(rd.dir, '.git', 'info', 'exclude');
      const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
      if (!existing.includes('.warp-coder-ask')) {
        writeFileSync(excludeFile, existing.trimEnd() + '\n.warp-coder-ask\n');
      }

      // Auto-commit if Claude left uncommitted changes
      if (git.status(rd.dir)) {
        log(`  ${rd.dirName}: claude forgot to commit — auto-committing`);
        git.commitAll(rd.dir, 'Address review feedback');
      }

      const headAfter = git.getHead(rd.dir);
      const headBefore = headsBefore.get(rd.dir);

      if (headAfter === headBefore) {
        log(`  ${rd.dirName}: no changes`);
        continue;
      }

      anyChanges = true;
      log(`  ${rd.dirName}: pushing...`);
      git.push(rd.dir, rd.branch);
    }

    // Update act marker on all PRs so any repo's review can trigger revise
    if (actId) {
      for (const rd of repoDirs) {
        if (!rd.hasPR) continue;
        try {
          let body = git.getPRBody(rd.prNumber, { repo: rd.name });
          body = body.replace(/<!-- wm:act:wm_act_\w+ -->/, `<!-- wm:act:${actId} -->`);
          if (!body.includes(`<!-- wm:act:${actId} -->`)) {
            body += `\n\n<!-- wm:act:${actId} -->`;
          }
          git.updatePRBody(rd.prNumber, { repo: rd.name, body });
        } catch (err) {
          log(`  warning: could not update PR body with act ID: ${err.message}`);
        }
      }
    }

    if (!anyChanges) {
      log('  no changes needed — review feedback already addressed');

      // Dismiss active CHANGES_REQUESTED reviews across all PRs
      for (const { repo, prNumber } of prs) {
        try {
          const reviews = git.getReviews(prNumber, { repo });
          for (const r of reviews) {
            if (r.state === 'CHANGES_REQUESTED') {
              git.dismissReview(prNumber, r.id, {
                repo,
                message: 'Code verified correct by warp-coder — no changes needed.',
              });
              log(`  dismissed stale review ${r.id} on ${repo}#${prNumber}`);
            }
          }
        } catch (err) {
          log(`  warning: could not dismiss stale reviews on ${repo}#${prNumber}: ${err.message}`);
        }
      }

      // Empty commit + push on each PR repo to trigger fresh warp-review
      for (const rd of repoDirs) {
        if (!rd.hasPR) continue;
        git.commitAll(rd.dir, 'Verified correct — review feedback already addressed', { allowEmpty: true });
        git.push(rd.dir, rd.branch);
      }
      log('  pushed empty commits to trigger review');
    }

    // Move back to In Review
    try {
      await board.moveToReview(item);
      log('  moved to In Review');
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
          prNumber: primaryPRNumber,
          reviewCommentCount: allReviewComments.length,
          ...(hitMaxTurns ? { name: 'Max Retries' } : {}),
        });
        log(`  outcome: ${outcome.name}`);

        // Emit act so warp-review can link its next review as a follow-up
        if (success && actId && outcome.runOutcomeId) {
          await warp.emitAct(config.warpmetricsApiKey, {
            outcomeId: outcome.runOutcomeId,
            actId,
            name: 'Review',
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
          prNumber: primaryPRNumber,
          success,
          error: taskError,
          hookOutputs: hookOutputs.filter(h => h.ran),
          reviewComments: allReviewComments,
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

  return { success, reason: success ? 'ok' : 'error' };
}
