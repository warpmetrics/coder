// Main poll loop: watches the board and processes tasks sequentially.

import { loadConfig } from './config.js';
import { createBoard } from './boards/index.js';
import { implement } from './agent.js';
import { revise } from './revise.js';
import * as git from './git.js';
import * as warp from './warp.js';
import { runHook } from './hooks.js';

export async function watch() {
  const config = loadConfig();
  const board = createBoard(config);
  const pollInterval = (config.pollInterval || 30) * 1000;
  const repoName = config.repo.replace(/\.git$/, '').replace(/^.*github\.com[:\/]/, '');

  // Track issue runs across poll cycles (issueNumber → { runId })
  const issueRuns = new Map();

  let running = true;
  let sleepResolve = null;
  const shutdown = () => {
    if (!running) {
      console.log('\nForce exit.');
      process.exit(1);
    }
    console.log('\nShutting down... (Ctrl+C again to force)');
    running = false;
    if (sleepResolve) sleepResolve();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

  log('warp-coder watching...');
  log(`  board: ${config.board.provider} (project ${config.board.project})`);
  log(`  repo: ${config.repo}`);
  log(`  poll interval: ${config.pollInterval || 30}s`);

  while (running) {
    try {
      // Fetch all project items once per poll cycle
      board.refresh();

      // 1. Pick up new tasks from Todo
      const todoItems = await board.listTodo();
      if (todoItems.length > 0) {
        const item = todoItems[0];
        const issueNumber = item.content?.number;
        const issueTitle = item.content?.title;
        log(`Found todo: #${issueNumber} — ${issueTitle}`);

        // Create issue run (root of the lifecycle chain)
        let implementActId = null;
        if (config.warpmetricsApiKey && !issueRuns.has(issueNumber)) {
          try {
            const issue = await warp.createIssueRun(config.warpmetricsApiKey, {
              repo: repoName, issueNumber, issueTitle,
            });
            issueRuns.set(issueNumber, { runId: issue.runId });
            implementActId = issue.actId;
            log(`  issue run: ${issue.runId}`);
          } catch (err) {
            log(`  warning: issue run creation failed: ${err.message}`);
          }
        }

        await implement(item, { board, config, log, refActId: implementActId });
      }

      // 2. Check for items needing revision
      const reviewItems = await board.listInReview();
      for (const item of reviewItems) {
        if (!running) break;
        log(`Found review feedback: PR #${item._prNumber || item.content?.number}`);
        await revise(item, { board, config, log, refActId: item._reviewActId });
      }

      // 3. Merge approved PRs
      const approvedItems = await board.listApproved();
      for (const item of approvedItems) {
        if (!running) break;
        const prNumber = item._prNumber || item.content?.number;
        const refActId = item._reviewActId;
        log(`Merging approved PR #${prNumber}`);

        // Create merge run (follow-up of review's "merge" act)
        let mergeRunId = null;
        let mergeGroupId = null;
        if (config.warpmetricsApiKey) {
          try {
            const pipeline = await warp.startPipeline(config.warpmetricsApiKey, {
              step: 'merge', repo: repoName, prNumber, refActId,
            });
            mergeRunId = pipeline.runId;
            mergeGroupId = pipeline.groupId;
          } catch (err) {
            log(`  warning: merge pipeline failed: ${err.message}`);
          }
        }

        try {
          runHook('onBeforeMerge', config, { prNumber, repo: repoName });
          git.mergePR(prNumber, { repo: repoName });
          runHook('onMerged', config, { prNumber, repo: repoName });
          await board.moveToDone(item);
          log(`  merged and moved to Done`);

          // Record merge outcome
          if (config.warpmetricsApiKey && mergeGroupId) {
            try {
              await warp.recordOutcome(config.warpmetricsApiKey, { runId: mergeRunId, groupId: mergeGroupId }, {
                step: 'merge', success: true, prNumber,
              });
            } catch {}
          }

          // Close the issue run with "Shipped"
          const issueNumber = item.content?.number;
          const issueCtx = issueRuns.get(issueNumber);
          if (config.warpmetricsApiKey && issueCtx) {
            try {
              await warp.closeIssueRun(config.warpmetricsApiKey, {
                runId: issueCtx.runId, name: 'Shipped',
              });
              issueRuns.delete(issueNumber);
            } catch {}
          }
        } catch (err) {
          log(`  merge failed: ${err.message}`);
          if (config.warpmetricsApiKey && mergeGroupId) {
            try {
              await warp.recordOutcome(config.warpmetricsApiKey, { runId: mergeRunId, groupId: mergeGroupId }, {
                step: 'merge', success: false, error: err.message, prNumber,
              });
            } catch {}
          }
        }
      }
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }

    // Sleep (interruptible)
    if (running) {
      await new Promise(resolve => {
        sleepResolve = resolve;
        setTimeout(() => { sleepResolve = null; resolve(); }, pollInterval);
      });
    }
  }

  log('Stopped.');
}
