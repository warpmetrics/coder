// CLI entry: spinner UI + adapter wiring + poll loop.
// All orchestration logic lives in runner.js + machine.js.

import { loadConfig, repoName } from '../config.js';
import { createBoard } from '../boards/index.js';
import { createCodeHost } from '../codehosts/index.js';
import { implement, revise } from '../executors/claude/index.js';
import { review } from '../executors/claude/review.js';
import { merge } from '../executors/codehost.js';
import { deploy as executeDeploy } from '../executors/deploy.js';
import { computeDeployBatch } from '../workflows/plan.js';
import * as warp from '../client/warp.js';
import { OUTCOMES, ACTS } from '../names.js';
import { createRunner } from '../runner.js';

// --- Spinner (status line) ---
const SPINNER = ['\u28CB', '\u28D9', '\u28F9', '\u28F8', '\u28FC', '\u28F4', '\u28E6', '\u28E7', '\u28C7', '\u28CF'];
const statusTasks = new Map();
let spinnerIdx = 0;
let spinnerTimer = null;
const isTTY = process.stderr.isTTY;

function clearStatus() { if (isTTY) process.stderr.write('\x1b[2K\r'); }
function renderStatus() {
  if (!isTTY || statusTasks.size === 0) return;
  const parts = [];
  for (const [id, { step, startedAt }] of statusTasks) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    parts.push(`#${id} ${step}${elapsed > 2 ? ` ${elapsed}s` : ''}`);
  }
  clearStatus();
  process.stderr.write(`${SPINNER[spinnerIdx]} ${parts.join(' \u00B7 ')}`);
}
function startStatus() { if (isTTY) spinnerTimer = setInterval(() => { spinnerIdx = (spinnerIdx + 1) % SPINNER.length; renderStatus(); }, 100); }
function stopStatus() { if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; } clearStatus(); }
function setStep(issueId, step) { statusTasks.set(issueId, { step, startedAt: Date.now() }); }
function clearStep(issueId) { statusTasks.delete(issueId); if (statusTasks.size === 0) clearStatus(); }

// --- Board adapter ---

function createBoardAdapter(board, codehost, repoNames) {
  return {
    async scanNewIssues() {
      await board.refresh(); // Single refresh per poll — getAllItems reuses cache.
      const items = await board.listTodo();
      return items.filter(i => i._issueId).map(i => ({
        issueId: i._issueId, repo: i.content?.repository || repoNames[0], title: i.content?.title,
      }));
    },
    async syncState(item, column) {
      const methods = { todo: 'moveToTodo', inProgress: 'moveToInProgress', inReview: 'moveToReview', readyForDeploy: 'moveToReadyForDeploy', deploy: 'moveToDeploy', blocked: 'moveToBlocked', waiting: 'moveToWaiting', done: 'moveToDone' };
      const method = methods[column];
      if (method && board[method]) await board[method](item);
    },
    async getAllItems() {
      // No refresh — reuses cache from scanNewIssues in same poll cycle.
      const all = [];
      for (const fn of [board.listTodo, board.listInProgress, board.listInReview, board.listWaiting, board.listDone]) {
        try { all.push(...await fn.call(board)); } catch {}
      }
      return all;
    },
    async scanAborted() {
      try {
        const items = board.listAborted ? await board.listAborted() : [];
        return new Set(items.filter(i => i._issueId).map(i => i._issueId));
      } catch { return new Set(); }
    },
  };
}

// --- Execute adapters ---

function createExecutors() {
  return {
    async implement(run, { codehost, config, repoNames, log, actOpts }) {
      const item = run.boardItem || { _issueId: run.issueId, content: { title: run.title, body: '', number: run.issueId } };
      const onStep = (step) => setStep(run.issueId, step);
      const onBeforeLog = clearStatus;
      const resumeSession = actOpts?.sessionId || undefined;
      const r = await implement(item, { config, codehost, log, onStep, onBeforeLog, resumeSession });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { ...actOpts, prs: r.prs, issueId: run.issueId, repo: actOpts?.repo || repoNames[0],
            releaseSteps: r.deployPlan?.releaseSteps || [], releaseDAG: r.deployPlan?.releaseDAG || {} } };
      }
      if (r.type === 'ask_user') {
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { ...actOpts, issueId: run.issueId, repo: actOpts?.repo || repoNames[0], title: run.title, question: r.question } };
      }
      if (r.type === 'max_turns') {
        const retryCount = (actOpts?.retryCount || 0) + 1;
        const limit = config.maxTurnsRetries || 3;
        if (retryCount >= limit) {
          log(`max_turns limit reached (${retryCount}/${limit}), giving up`);
          return { type: 'error', error: `Hit max turns ${retryCount} times without completing`, costUsd: r.costUsd, trace: r.trace, outcomeOpts: { issueNumber: run.issueId } };
        }
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { ...actOpts, sessionId: r.sessionId, retryCount } };
      }
      return { ...r, outcomeOpts: { issueNumber: run.issueId } };
    },
    async review(run, { codehost, config, repoNames, log, actOpts }) {
      const item = run.boardItem || { _issueId: run.issueId, content: { title: run.title } };
      const onStep = (step) => setStep(run.issueId, step);
      const onBeforeLog = clearStatus;
      const r = await review(item, { config, codehost, log, onStep, onBeforeLog, repoNames });

      if (r.type === 'approved') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { ...actOpts, prs: r.prs, issueId: run.issueId } };
      }
      if (r.type === 'changes_requested') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { ...actOpts, prs: r.prs, issueId: run.issueId, repo: actOpts?.repo || repoNames[0] } };
      }
      if (r.type === 'error') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: actOpts };
      }
      return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount } };
    },
    async revise(run, { codehost, config, repoNames, log, actOpts }) {
      const prs = actOpts?.prs || [];
      const item = run.boardItem || { _issueId: run.issueId, _prs: prs, _prNumber: prs[0]?.prNumber, content: { title: run.title } };
      if (prs.length && !item._prs) { item._prs = prs; item._prNumber = prs[0]?.prNumber; }
      const onStep = (step) => setStep(run.issueId, step);
      const onBeforeLog = clearStatus;
      const r = await revise(item, { config, codehost, log, onStep, onBeforeLog });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { prNumber: item._prNumber },
          nextActOpts: { ...actOpts, prs, issueId: run.issueId, repo: actOpts?.repo || repoNames[0] } };
      }
      return { ...r, outcomeOpts: { prNumber: item._prNumber } };
    },
    async merge(run, { codehost, config, repoNames, log, actOpts }) {
      const prs = actOpts?.prs || [];
      const item = run.boardItem || { _issueId: run.issueId, _prs: prs, content: { title: run.title } };
      if (prs.length && !item._prs) item._prs = prs;
      const r = await merge(item, { config, log, codehost, repoNames });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { prNumber: prs[0]?.prNumber },
          nextActOpts: { ...actOpts, prs, issueId: run.issueId } };
      }
      return { ...r, outcomeOpts: { prNumber: prs[0]?.prNumber } };
    },
    async await_deploy(run, { config, log, actOpts }) {
      const deployColName = config.board?.columns?.deploy || 'Deploy';
      const currentCol = run.boardItem?.status || run.boardItem?._stateName;

      if (currentCol !== deployColName) {
        return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: actOpts };
      }

      log(`deploy approved (moved to ${deployColName})`);
      return { type: 'approved', costUsd: null, trace: null, outcomeOpts: {},
        nextActOpts: actOpts };
    },
    async await_reply(run, { codehost, repoNames, log, actOpts }) {
      const primaryRepo = repoNames[0];
      let comments;
      try { comments = codehost.getIssueComments(run.issueId, { repo: primaryRepo }); } catch { return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: actOpts }; }

      const lastQuestionIdx = comments.findLastIndex(c => c.body?.includes('<!-- warp-coder:question'));
      if (lastQuestionIdx === -1 || lastQuestionIdx === comments.length - 1) {
        return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: actOpts };
      }

      log(`user replied to clarification question`);
      return { type: 'replied', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: actOpts };
    },
    async deploy(run, { codehost, config, repoNames, log, actOpts, deployBatch }) {
      const result = await executeDeploy(actOpts, { codehost, deployBatch, log });
      return {
        ...result,
        costUsd: null, trace: null,
        outcomeOpts: { stepCount: result.steps?.length },
        nextActOpts: actOpts,
        batchedIssues: deployBatch?.issues?.filter(i => i.issueId !== run.issueId) || [],
      };
    },
    async release(run, { codehost, config, repoNames, log, actOpts }) {
      const releaseSteps = actOpts?.releaseSteps || [];
      log(`release notes not yet implemented (${releaseSteps.length} repo(s))`);
      return { type: 'success', costUsd: null, trace: null, outcomeOpts: {} };
    },
  };
}

// --- Effect adapters ---

function createEffects() {
  return {
    async 'implement:error'(run, result, { codehost, repoNames, log }) {
      const primaryRepo = repoNames[0];
      const error = result.error || 'Unknown error';
      try {
        codehost.botComment(run.issueId, {
          repo: primaryRepo, runId: run.id,
          body: `<!-- warp-coder:error\n${error}\n-->\n\nImplementation failed — needs human intervention.\n\n<details>\n<summary>Error details</summary>\n\n\`\`\`\n${error}\n\`\`\`\n</details>`,
        });
        log(`posted error comment`);
      } catch {}
    },
    async 'implement:ask_user'(run, result, { codehost, repoNames, log }) {
      const primaryRepo = repoNames[0];
      const marker = `<!-- warp-coder:question -->`;
      try { codehost.botComment(run.issueId, { repo: primaryRepo, runId: run.id, body: `${marker}\n\nNeeds clarification:\n\n${result.question}` }); log(`posted clarification question`); } catch {}
    },
    async 'revise:error'(run, result, { codehost, repoNames, log }) {
      const error = result.error || 'Unknown error';
      try {
        codehost.botComment(run.issueId, {
          repo: repoNames[0], runId: run.id,
          body: `<!-- warp-coder:error\n${error}\n-->\n\nRevision failed — needs human intervention.\n\n<details>\n<summary>Error details</summary>\n\n\`\`\`\n${error}\n\`\`\`\n</details>`,
        });
      } catch {}
    },
    async 'revise:max_retries'(run, result, { codehost, repoNames, log }) {
      try {
        codehost.botComment(run.issueId, {
          repo: repoNames[0], runId: run.id,
          body: `<!-- warp-coder:error\nMax retries (${result.count})\n-->\n\nHit revision limit (${result.count} attempts) — needs human help.`,
        });
      } catch {}
    },
    async 'merge:success'(run, result, { codehost, repoNames, log }) {
      try {
        codehost.botComment(run.issueId, {
          repo: repoNames[0], runId: run.id,
          body: `Merged successfully. Move to **Deploy** to trigger deployment.`,
        });
      } catch {}
    },
    async 'deploy:success'(run, result, { warp, apiKey, log }) {
      for (const issue of (result.batchedIssues || [])) {
        try {
          // Record DEPLOY_APPROVED + DEPLOYED on the Deploy group
          if (issue.parentEntityId) {
            await warp.recordIssueOutcome(apiKey, { runId: issue.parentEntityId, name: OUTCOMES.DEPLOY_APPROVED });
            await warp.recordIssueOutcome(apiKey, { runId: issue.parentEntityId, name: OUTCOMES.DEPLOYED });
          }
          // Record DEPLOYED on the Issue Run
          const { outcomeId } = await warp.recordIssueOutcome(apiKey, { runId: issue.runId, name: OUTCOMES.DEPLOYED });
          // Emit RELEASE act with this issue's own release data
          if (outcomeId) {
            await warp.emitAct(apiKey, {
              outcomeId,
              name: ACTS.RELEASE,
              opts: { prs: issue.prs, issueId: issue.issueId, releaseSteps: issue.releaseSteps, releaseDAG: issue.releaseDAG },
            });
          }
          log(`advanced batched issue ${issue.issueId} to RELEASE`);
        } catch (err) {
          log(`warning: failed to advance batched issue ${issue.issueId}: ${err.message}`);
        }
      }
    },
  };
}

// --- Main ---

export async function watch() {
  const config = loadConfig();
  const rawBoard = createBoard(config);
  const codehost = createCodeHost(config);
  const repoNames = config.repos.map(repoName);
  const pollInterval = (config.pollInterval || 30) * 1000;
  const apiKey = config.warpmetricsApiKey;

  const boardAdapter = createBoardAdapter(rawBoard, codehost, repoNames);

  const runner = createRunner({
    warp,
    board: boardAdapter,
    codehost,
    config: { ...config, repoNames, warpmetricsApiKey: apiKey, concurrency: config.concurrency || 1 },
    execute: createExecutors(),
    effects: createEffects(),
    findDeployBatch: async (run, act) => {
      const openRuns = await warp.findOpenIssueRuns(apiKey);
      const awaiting = openRuns
        .filter(r => r.pendingAct?.name === ACTS.AWAIT_DEPLOY || r.pendingAct?.name === ACTS.RUN_DEPLOY)
        .map(r => ({
          issueId: r.issueId,
          runId: r.id,
          parentEntityId: r.parentEntityId,
          prs: r.pendingAct?.opts?.prs || [],
          releaseSteps: r.pendingAct?.opts?.releaseSteps || [],
          releaseDAG: r.pendingAct?.opts?.releaseDAG || {},
        }));
      return computeDeployBatch(run.issueId, awaiting);
    },
    log: (issueId, msg) => {
      clearStatus();
      const prefix = issueId ? `[#${issueId}]` : '';
      console.log(`[${new Date().toISOString()}] ${prefix}${prefix ? ' ' : ''}${msg}`);
    },
  });

  let running = true;
  let sleepResolve = null;
  const shutdown = () => {
    if (!running) { stopStatus(); console.log('\nForce exit.'); process.exit(1); }
    stopStatus();
    console.log('\nShutting down... (Ctrl+C again to force)');
    running = false;
    if (sleepResolve) sleepResolve();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  startStatus();

  console.log(`[${new Date().toISOString()}] warp-coder watching...`);
  console.log(`  board: ${config.board.provider}${config.board.project ? ` (project ${config.board.project})` : ''}`);
  console.log(`  repos: ${repoNames.join(', ')}`);
  console.log(`  concurrency: ${config.concurrency || 1}`);
  console.log(`  poll interval: ${config.pollInterval || 30}s`);

  while (running) {
    try {
      codehost.clearCache();
      const stats = await runner.poll({
        onStep: setStep,
        onClearStep: clearStep,
      });

      if (stats.total === 0 && stats.inFlight === 0) {
        console.log(`[${new Date().toISOString()}] Nothing to do`);
      }
    } catch (err) {
      console.log(`[${new Date().toISOString()}] Poll error: ${err.message}`);
    }

    if (running) {
      await new Promise(resolve => { sleepResolve = resolve; setTimeout(() => { sleepResolve = null; resolve(); }, pollInterval); });
    }
  }

  await runner.waitForInFlight();
  stopStatus();
  console.log(`[${new Date().toISOString()}] Stopped.`);
}
