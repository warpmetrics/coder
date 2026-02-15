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

export async function revise(item, { board, config, log }) {
  const prNumber = item.content?.number;
  const repo = config.repo;
  const repoName = repo.replace(/\.git$/, '').split('/').pop();
  const maxRevisions = config.maxRevisions || 3;
  const workdir = join(tmpdir(), 'warp-coder', `revise-${prNumber}`);
  const configDir = join(process.cwd(), CONFIG_DIR);

  log(`Revising PR #${prNumber}`);

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
  let groupId = null;
  if (config.warpmetricsApiKey) {
    try {
      const pipeline = await warp.startPipeline(config.warpmetricsApiKey, {
        step: 'revise',
        repo: repoName,
        prNumber,
      });
      groupId = pipeline.groupId;
      log(`  pipeline: run=${pipeline.runId} group=${groupId}`);
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
    log(`  cloning into ${workdir}`);
    git.cloneRepo(repo, workdir);

    const branch = git.getPRBranch(prNumber, { repo: repoName });
    git.checkoutBranch(workdir, branch);
    log(`  branch: ${branch}`);

    // Fetch review comments for context
    try {
      reviewComments = git.getReviews(prNumber, { repo: repoName });
    } catch (err) {
      log(`  warning: could not fetch reviews: ${err.message}`);
    }

    // Load memory for prompt enrichment
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';

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

    promptParts.push(
      'A code review has been submitted with comments. Your job:',
      '',
      '1. Read all review comments on this PR',
      '2. Apply the suggested fixes',
      '3. Run tests to make sure everything passes',
      '4. Commit the fixes with a message like "Address review feedback"',
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

    // Push
    log('  pushing...');
    git.push(workdir, branch);

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
  } finally {
    // WarpMetrics: record outcome
    if (config.warpmetricsApiKey && groupId) {
      try {
        const outcome = await warp.recordOutcome(config.warpmetricsApiKey, groupId, {
          step: 'revise',
          success,
          costUsd: claudeResult?.costUsd,
          error: taskError,
          hooksFailed: hookOutputs.some(h => h.exitCode !== 0),
          prNumber,
          reviewCommentCount: reviewComments.length,
        });
        log(`  outcome: ${outcome.name}`);
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
