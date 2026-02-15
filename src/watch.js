// Main poll loop: watches the board and processes tasks sequentially.

import { loadConfig } from './config.js';
import { createBoard } from './boards/index.js';
import { implement } from './agent.js';
import { revise } from './revise.js';
import * as git from './git.js';
import { runHook } from './hooks.js';

export async function watch() {
  const config = loadConfig();
  const board = createBoard(config);
  const pollInterval = (config.pollInterval || 30) * 1000;

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
        log(`Found todo: #${item.content?.number} — ${item.content?.title}`);
        await implement(item, { board, config, log });
      }

      // 2. Check for items needing revision
      const reviewItems = await board.listInReview();
      for (const item of reviewItems) {
        if (!running) break;
        log(`Found review feedback: PR #${item._prNumber || item.content?.number}`);
        await revise(item, { board, config, log });
      }

      // 3. Merge approved PRs
      const approvedItems = await board.listApproved();
      for (const item of approvedItems) {
        if (!running) break;
        const prNumber = item._prNumber || item.content?.number;
        const repoName = config.repo.replace(/\.git$/, '').replace(/^.*github\.com[:\/]/, '');
        log(`Merging approved PR #${prNumber}`);
        try {
          runHook('onBeforeMerge', config, { prNumber, repo: repoName });
          git.mergePR(prNumber, { repo: repoName });
          runHook('onMerged', config, { prNumber, repo: repoName });
          await board.moveToDone(item);
          log(`  merged and moved to Done`);
        } catch (err) {
          log(`  merge failed: ${err.message}`);
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
