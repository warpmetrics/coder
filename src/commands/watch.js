// CLI entry: spinner UI + adapter wiring + poll loop.
// All orchestration logic lives in runner.js + machine.js.

import { execFileSync } from 'child_process';
import { loadConfig, repoName } from '../config.js';
import { createBoard } from '../boards/index.js';
import { createCodeHost } from '../codehosts/index.js';
import { implement, revise } from '../executors/claude/index.js';
import { review } from '../executors/claude/review.js';
import { merge } from '../executors/codehost.js';
import { deploy as executeDeploy } from '../executors/deploy.js';
import { generateChangelogEntry, createChangelogProvider, PUBLIC_PROMPT, PRIVATE_PROMPT } from '../executors/changelog/lib.js';
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
      for (const fn of [board.listTodo, board.listInProgress, board.listInReview, board.listReadyForDeploy, board.listDeploy, board.listBlocked, board.listWaiting, board.listDone]) {
        if (fn) try { all.push(...await fn.call(board)); } catch {}
      }
      return all;
    },
    async scanAborted() {
      try {
        const items = board.listAborted ? await board.listAborted() : [];
        return new Set(items.filter(i => i._issueId).map(i => i._issueId));
      } catch { return new Set(); }
    },
    async scanDone() {
      try {
        const items = board.listDone ? await board.listDone() : [];
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
          nextActOpts: { prs: r.prs, release: r.deployPlan?.release || [] } };
      }
      if (r.type === 'ask_user') {
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { sessionId: r.sessionId } };
      }
      if (r.type === 'max_turns') {
        const retryCount = (actOpts?.retryCount || 0) + 1;
        const limit = config.maxTurnsRetries || 3;
        if (retryCount >= limit) {
          log(`max_turns limit reached (${retryCount}/${limit}), giving up`);
          return { type: 'error', error: `Hit max turns ${retryCount} times without completing`, costUsd: r.costUsd, trace: r.trace, outcomeOpts: { issueNumber: run.issueId } };
        }
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { sessionId: r.sessionId, retryCount } };
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
          nextActOpts: { prs: r.prs, release: actOpts?.release } };
      }
      if (r.type === 'changes_requested') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { prs: r.prs, release: actOpts?.release } };
      }
      if (r.type === 'error') {
        return { ...r, outcomeOpts: { prNumber: r.prNumber, reviewCommentCount: r.commentCount },
          nextActOpts: { prs: r.prs || actOpts?.prs, release: actOpts?.release } };
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
          nextActOpts: { prs, release: actOpts?.release } };
      }
      return { ...r, outcomeOpts: { prNumber: item._prNumber },
        nextActOpts: { prs, release: actOpts?.release } };
    },
    async merge(run, { codehost, config, repoNames, log, actOpts }) {
      const prs = actOpts?.prs || [];
      const item = run.boardItem || { _issueId: run.issueId, _prs: prs, content: { title: run.title } };
      if (prs.length && !item._prs) item._prs = prs;
      const r = await merge(item, { config, log, codehost, repoNames });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { prNumber: prs[0]?.prNumber },
          nextActOpts: { prs, release: actOpts?.release } };
      }
      // On partial merge, only retry the failed PRs.
      const retryPrs = r.failedPrs?.length ? r.failedPrs : prs;
      return { ...r, outcomeOpts: { prNumber: prs[0]?.prNumber },
        nextActOpts: { prs: retryPrs, release: actOpts?.release } };
    },
    async await_deploy(run, { config, log, actOpts }) {
      const deployColName = config.board?.columns?.deploy || 'Deploy';
      const currentCol = run.boardItem?.status || run.boardItem?._stateName;
      const fwd = { prs: actOpts?.prs, release: actOpts?.release };

      if (currentCol !== deployColName) {
        return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: fwd };
      }

      log(`deploy approved (moved to ${deployColName})`);
      return { type: 'approved', costUsd: null, trace: null, outcomeOpts: {},
        nextActOpts: fwd };
    },
    async await_reply(run, { codehost, repoNames, log, actOpts }) {
      const primaryRepo = repoNames[0];
      let comments;
      try { comments = codehost.getIssueComments(run.issueId, { repo: primaryRepo }); } catch { return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: { sessionId: actOpts?.sessionId } }; }

      const lastQuestionIdx = comments.findLastIndex(c => c.body?.includes('<!-- warp-coder:question'));
      if (lastQuestionIdx === -1 || lastQuestionIdx === comments.length - 1) {
        return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: { sessionId: actOpts?.sessionId } };
      }

      log(`user replied to clarification question`);
      return { type: 'replied', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: { sessionId: actOpts?.sessionId } };
    },
    async deploy(run, { codehost, config, repoNames, log, actOpts, deployBatch }) {
      const result = await executeDeploy(actOpts, { codehost, deployBatch, log });
      const batchedIssues = deployBatch?.issues?.filter(i => i.issueId !== run.issueId) || [];
      // nextActOpts is serialized to JSON — convert Maps to plain objects.
      const serializedBatch = batchedIssues.map(i => ({
        issueId: i.issueId, runId: i.runId, title: i.title, prs: i.prs,
        groups: i.groups ? Object.fromEntries(i.groups) : {},
      }));
      return {
        ...result,
        costUsd: null, trace: null,
        outcomeOpts: { stepCount: result.steps?.length },
        nextActOpts: { prs: actOpts?.prs, release: actOpts?.release, batchedIssues: serializedBatch },
        batchedIssues,
      };
    },
    async release(run, { codehost, config, repoNames, log, actOpts }) {
      const batchedIssues = actOpts?.batchedIssues || [];

      // Collect PRs from trigger issue + all batched issues
      const allPrs = [...(actOpts?.prs || [])];
      const allIssueLines = [`#${run.issueId}: ${run.title || `Issue #${run.issueId}`}`];
      for (const issue of batchedIssues) {
        for (const pr of (issue.prs || [])) {
          if (!allPrs.some(p => p.repo === pr.repo && p.prNumber === pr.prNumber)) {
            allPrs.push(pr);
          }
        }
        allIssueLines.push(`#${issue.issueId}: ${issue.title || `Issue #${issue.issueId}`}`);
      }

      // Gather PR context (files + commits)
      const prContext = [];
      for (const { repo, prNumber } of allPrs) {
        try {
          const files = codehost.getPRFiles(prNumber, { repo });
          const commits = codehost.getPRCommits(prNumber, { repo });
          prContext.push({ repo, prNumber, files, commits });
        } catch (err) {
          log(`warning: could not fetch PR ${repo}#${prNumber}: ${err.message}`);
        }
      }

      if (prContext.length === 0) {
        log('no PR context available, skipping changelog');
        return { type: 'success', costUsd: null, trace: null, outcomeOpts: {}, batchedIssues };
      }

      // Build changelog prompt context
      const technicalContext = prContext.map(({ repo, prNumber, files, commits }) => {
        const commitLines = commits.map(c => `- ${c.messageHeadline || c.message?.split('\n')[0] || ''}`).join('\n');
        const fileLines = files.map(f => `  ${f.path} (+${f.additions || 0} -${f.deletions || 0})`).join('\n');
        return `Repo: ${repo}, PR #${prNumber}\nCommits:\n${commitLines}\nFiles:\n${fileLines}`;
      }).join('\n\n');
      const context = `Issues:\n${allIssueLines.join('\n')}\n\n---\n\nChanges:\n${technicalContext}`;

      const modelOpts = config.quickModel ? { model: config.quickModel } : {};

      log('generating changelog entries...');
      const publicEntry = generateChangelogEntry(execFileSync, `${PUBLIC_PROMPT}\n\n---\n\n${context}`, modelOpts);
      const privateEntry = generateChangelogEntry(execFileSync, `${PRIVATE_PROMPT}\n\n---\n\n${context}`, modelOpts);

      if (!publicEntry && !privateEntry) {
        log('changelog generation failed');
        return { type: 'success', costUsd: null, trace: null, outcomeOpts: {}, batchedIssues };
      }

      // Publish entries
      const provider = createChangelogProvider(config);
      if (!provider) {
        log('no changelog provider configured, skipping publish');
        return { type: 'success', costUsd: null, trace: null, outcomeOpts: {}, batchedIssues };
      }

      for (const [label, entry, visibility] of [['public', publicEntry, 'public'], ['private', privateEntry, 'private']]) {
        if (!entry) continue;
        try {
          await provider.post({ title: entry.title, summary: entry.summary, content: entry.content, visibility, tags: entry.tags });
          log(`${label} changelog entry published`);
        } catch (err) {
          log(`${label} changelog entry failed: ${err.message}`);
        }
      }

      return { type: 'success', costUsd: null, trace: null, outcomeOpts: {}, batchedIssues };
    },
  };
}

// --- Effect adapters ---

function createEffects() {
  return {
    async 'implement:success'(run, result, { codehost, repoNames, log }) {
      const primaryRepo = repoNames[0];
      const release = result.nextActOpts?.release || [];
      const prs = result.nextActOpts?.prs || [];
      const repos = release.length > 0
        ? release.map(s => s.repo)
        : prs.map(p => p.repo);
      const labels = [...new Set(repos)].map(r => `deploy:${r.split('/').pop()}`);
      if (labels.length === 0) return;
      try {
        codehost.addLabels(run.issueId, labels, { repo: primaryRepo });
        log(`tagged: ${labels.join(', ')}`);
      } catch (err) {
        log(`warning: could not add labels: ${err.message}`);
      }
    },
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
    async 'deploy:success'(run, result, { warp, apiKey, board, log }) {
      const batched = result.batchedIssues || [];
      if (batched.length === 0) return;

      let boardItemsByIssueId = new Map();
      if (board) {
        try {
          const items = await board.getAllItems();
          for (const item of items) {
            if (item._issueId) boardItemsByIssueId.set(item._issueId, item);
          }
        } catch {}
      }

      for (const issue of batched) {
        try {
          // Record Deploy phase outcomes
          const deployGroup = issue.groups.get('Deploy');
          if (deployGroup) {
            await warp.recordIssueOutcome(apiKey, { runId: deployGroup, name: OUTCOMES.DEPLOY_APPROVED });
            await warp.recordIssueOutcome(apiKey, { runId: deployGroup, name: OUTCOMES.DEPLOYED });
          }
          await warp.recordIssueOutcome(apiKey, { runId: issue.runId, name: OUTCOMES.DEPLOYED });
          const boardItem = boardItemsByIssueId.get(issue.issueId);
          if (board && boardItem) {
            await board.syncState(boardItem, 'deploy');
          }
          log(`batched issue #${issue.issueId} deployed`);
        } catch (err) {
          log(`warning: failed to advance batched issue ${issue.issueId}: ${err.message}`);
        }
      }
    },
    async 'release:success'(run, result, { warp, apiKey, board, log }) {
      const batched = result.batchedIssues || [];
      if (batched.length === 0) return;

      // Look up board items for batched issues (not serializable in actOpts).
      let boardItemsByIssueId = new Map();
      if (board) {
        try {
          const items = await board.getAllItems();
          for (const item of items) {
            if (item._issueId) boardItemsByIssueId.set(item._issueId, item);
          }
        } catch {}
      }

      for (const issue of batched) {
        try {
          // Groups come as plain object from serialized actOpts.
          const groups = issue.groups || {};
          const releaseGroup = groups['Release'];
          if (releaseGroup) {
            await warp.recordIssueOutcome(apiKey, { runId: releaseGroup, name: OUTCOMES.RELEASING });
            await warp.recordIssueOutcome(apiKey, { runId: releaseGroup, name: OUTCOMES.RELEASED });
          }
          await warp.recordIssueOutcome(apiKey, { runId: issue.runId, name: OUTCOMES.RELEASED });
          // Sync board to done
          const boardItem = boardItemsByIssueId.get(issue.issueId);
          if (board && boardItem) {
            await board.syncState(boardItem, 'done');
          }
          log(`batched issue #${issue.issueId} released`);
        } catch (err) {
          log(`warning: failed to release batched issue ${issue.issueId}: ${err.message}`);
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
  const repoNames = config.repos.map(r => repoName(r));
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
          title: r.title,
          groups: r.groups || new Map(),
          prs: r.pendingAct?.opts?.prs || [],
          release: r.pendingAct?.opts?.release || [],
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
