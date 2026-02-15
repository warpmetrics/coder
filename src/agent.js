// Implement a single task: clone → branch → claude → push → PR

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

export async function implement(item, { board, config, log }) {
  const issueNumber = item.content?.number;
  const issueTitle = item.content?.title || `Issue #${issueNumber}`;
  const issueBody = item.content?.body || '';
  const repo = config.repo;
  const repoName = repo.replace(/\.git$/, '').split('/').pop(); // owner/repo or just repo
  const branch = `agent/issue-${issueNumber}`;
  const workdir = join(tmpdir(), 'warp-coder', String(issueNumber));
  const configDir = join(process.cwd(), CONFIG_DIR);

  log(`Implementing #${issueNumber}: ${issueTitle}`);

  // Move to In Progress
  try {
    await board.moveToInProgress(item);
  } catch (err) {
    log(`  warning: could not move to In Progress: ${err.message}`);
  }

  // WarpMetrics: start pipeline
  let groupId = null;
  if (config.warpmetricsApiKey) {
    try {
      const pipeline = await warp.startPipeline(config.warpmetricsApiKey, {
        step: 'implement',
        repo: repoName,
        issueNumber,
        issueTitle,
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
  const hookOutputs = [];

  try {
    // Clone
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    log(`  cloning into ${workdir}`);
    git.cloneRepo(repo, workdir);

    // Branch
    git.createBranch(workdir, branch);
    log(`  branch: ${branch}`);

    // Hook: onBranchCreate
    try {
      const h = runHook('onBranchCreate', config, { workdir, issueNumber, branch, repo: repoName });
      if (h.ran) hookOutputs.push(h);
    } catch (err) {
      if (err.hookResult) hookOutputs.push(err.hookResult);
      throw err;
    }

    // Load memory for prompt enrichment
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';

    // Claude
    const promptParts = [
      `You are working on the repository ${repoName}.`,
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
      `Implement the following GitHub issue:`,
      '',
      `**#${issueNumber}: ${issueTitle}**`,
      '',
      issueBody,
      '',
      'Steps:',
      '1. Read the codebase to understand relevant context',
      '2. Implement the changes',
      '3. Run tests to verify nothing is broken',
      '4. Commit with a clear message',
      '',
      'Do NOT create branches, push, or open PRs — just implement and commit.',
      'If the issue is unclear or you cannot implement it, explain what is missing.',
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
      const h = runHook('onBeforePush', config, { workdir, issueNumber, branch, repo: repoName });
      if (h.ran) hookOutputs.push(h);
    } catch (err) {
      if (err.hookResult) hookOutputs.push(err.hookResult);
      throw err;
    }

    // Push + PR
    log('  pushing...');
    git.push(workdir, branch);
    const pr = git.createPR(workdir, {
      title: issueTitle,
      body: `Closes #${issueNumber}\n\nImplemented by warp-coder.`,
    });
    log(`  PR created: ${pr.url}`);

    // Hook: onPRCreated
    try {
      const h = runHook('onPRCreated', config, { workdir, issueNumber, prNumber: pr.number, branch, repo: repoName });
      if (h.ran) hookOutputs.push(h);
    } catch (err) {
      if (err.hookResult) hookOutputs.push(err.hookResult);
      throw err;
    }

    // Move to In Review
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
          step: 'implement',
          success,
          costUsd: claudeResult?.costUsd,
          error: taskError,
          hooksFailed: hookOutputs.some(h => h.exitCode !== 0),
          issueNumber,
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
          step: 'implement',
          issue: { number: issueNumber, title: issueTitle },
          success,
          error: taskError,
          hookOutputs: hookOutputs.filter(h => h.ran),
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
