// CLI entry: spinner UI + adapter wiring + poll loop.
// All orchestration logic lives in runner.js + machine.js.

import { join } from 'path';
import { LIMITS } from '../defaults.js';
import { loadConfig, repoName, CONFIG_DIR } from '../config.js';
import { createBoard } from '../clients/boards/index.js';
import { createPRClient } from '../clients/prs/index.js';
import { createIssueClient } from '../clients/issues/index.js';
import { createNotifier } from '../clients/notify/index.js';
import { createGitClient } from '../clients/git.js';
import { computeDeployBatch } from '../executors/deploy/plan.js';
import { createBuiltins } from '../workflows/builtins.js';
import { validateGraph } from '../graph/index.js';
import * as warp from '../clients/warp.js';
import { createClaudeCodeClient } from '../clients/claude-code.js';
import { ACTS } from '../graph/names.js';
import { createRunner } from '../runner.js';
import { listSkills } from '../agent/skills.js';

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

function createBoardAdapter(board, repoNames) {
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
        return new Set(items.filter(i => i._issueId).map(i => `${i.content?.repository || repoNames[0]}#${i._issueId}`));
      } catch { return new Set(); }
    },
    async scanDone() {
      try {
        const items = board.listDone ? await board.listDone() : [];
        return new Set(items.filter(i => i._issueId).map(i => `${i.content?.repository || repoNames[0]}#${i._issueId}`));
      } catch { return new Set(); }
    },
    async scanBlocked() {
      try {
        const items = board.listBlocked ? await board.listBlocked() : [];
        return new Set(items.filter(i => i._issueId).map(i => `${i.content?.repository || repoNames[0]}#${i._issueId}`));
      } catch { return new Set(); }
    },
  };
}

// --- Workflow loading ---

function validateWorkflow(wf) {
  // Validate graph structure.
  const { ok, errors } = validateGraph(wf.graph, wf.states);
  if (!ok) {
    throw new Error(`Invalid workflow graph:\n${errors.join('\n')}`);
  }
  // Validate every executor referenced in the graph has a matching function.
  for (const [act, node] of Object.entries(wf.graph)) {
    if (node.executor !== null && typeof wf.executors[node.executor] !== 'function') {
      throw new Error(`Workflow graph references executor '${node.executor}' (act '${act}') but no matching function was provided`);
    }
  }
  // If executor definitions are provided, validate resultTypes cover graph expectations.
  if (wf.executorDefs) {
    const defsByName = new Map(wf.executorDefs.map(d => [d.name, d]));
    for (const [act, node] of Object.entries(wf.graph)) {
      if (node.executor === null) continue;
      const def = defsByName.get(node.executor);
      if (!def) continue;
      for (const resultType of Object.keys(node.results)) {
        if (!def.resultTypes.includes(resultType)) {
          throw new Error(`Executor '${node.executor}' does not declare result type '${resultType}' required by graph act '${act}'`);
        }
      }
    }
  }
}

// Resolve executor definitions from config specifiers.
// Each specifier is an import path to a module exporting default { name, resultTypes, create }.
async function resolveExecutorDefs(specifiers, baseDir) {
  const defs = [];
  for (const specifier of specifiers) {
    const mod = await import(join(baseDir, specifier));
    const def = mod.default;
    if (!def?.name || !def?.resultTypes || typeof def?.create !== 'function') {
      throw new Error(`Executor module '${specifier}' must export default { name, resultTypes, create }`);
    }
    defs.push(def);
  }
  return defs;
}

async function loadWorkflow(config) {
  const builtins = createBuiltins();
  if (!config.workflow) {
    return {
      graph: builtins.graph,
      executors: builtins.executors,
      executorDefs: builtins.executorDefs,
      effects: builtins.effects,
      states: builtins.states,
    };
  }
  const mod = await import(join(process.cwd(), CONFIG_DIR, config.workflow));
  if (typeof mod.defineWorkflow !== 'function') {
    throw new Error(`Workflow module must export a defineWorkflow() function`);
  }
  const wf = mod.defineWorkflow({ builtins });

  // Resolve config.executors specifiers and merge into workflow.
  if (config.executors?.length) {
    const customDefs = await resolveExecutorDefs(config.executors, join(process.cwd(), CONFIG_DIR));
    const mergedDefs = [...(wf.executorDefs || builtins.executorDefs)];
    for (const def of customDefs) {
      const idx = mergedDefs.findIndex(d => d.name === def.name);
      if (idx >= 0) mergedDefs[idx] = def;
      else mergedDefs.push(def);
    }
    wf.executorDefs = mergedDefs;
    // Rebuild executors map from merged definitions.
    for (const def of customDefs) {
      wf.executors[def.name] = def.create();
    }
  }

  validateWorkflow(wf);
  return wf;
}

// --- Main ---

export async function watch() {
  const config = loadConfig();
  const rawBoard = createBoard(config);
  const prs = createPRClient(config);
  const issues = createIssueClient(config);
  const notify = createNotifier(config);
  const git = createGitClient({ token: config.githubToken });
  const repoNames = config.repos.map(r => repoName(r));
  const pollInterval = (config.pollInterval || LIMITS.POLL_INTERVAL) * 1000;
  const apiKey = config.warpmetricsApiKey;

  const boardAdapter = createBoardAdapter(rawBoard, repoNames);
  const wf = await loadWorkflow(config);
  const fullConfig = { ...config, repoNames, warpmetricsApiKey: apiKey };
  const claudeCode = createClaudeCodeClient({ warp, apiKey, config: fullConfig });

  const runner = createRunner({
    warp,
    board: boardAdapter,
    git, prs, issues, notify,
    claudeCode,
    config: fullConfig,
    graph: wf.graph,
    states: wf.states,
    execute: wf.executors,
    effects: wf.effects,
    contextProviders: {
      deploy: async (run, act) => {
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
        return { deployBatch: computeDeployBatch(run.issueId, awaiting) };
      },
    },
    log: (issueId, msg) => {
      clearStatus();
      const prefix = issueId ? `[#${issueId}]` : '';
      process.stderr.write(`[${new Date().toISOString()}] ${prefix}${prefix ? ' ' : ''}${msg}\n`);
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

  const workflowLabel = config.workflow ? `custom (${config.workflow})` : 'default';
  console.log(`[${new Date().toISOString()}] warp-coder watching...`);
  console.log(`  board: ${config.board.provider}${config.board.project ? ` (project ${config.board.project})` : ''}`);
  console.log(`  repos: ${repoNames.join(', ')}`);
  console.log(`  workflow: ${workflowLabel}`);
  console.log(`  concurrency: ${config.concurrency || 1}`);
  console.log(`  poll interval: ${config.pollInterval || LIMITS.POLL_INTERVAL}s`);
  const skills = listSkills(join(process.cwd(), CONFIG_DIR));
  if (skills.length) console.log(`  skills: ${skills.join(', ')}`);

  while (running) {
    try {
      prs.clearCache();
      const stats = await runner.poll({
        onStep: setStep,
        onClearStep: clearStep,
        onBeforeLog: clearStatus,
      });

      clearStatus();
      if (stats.total === 0 && stats.inFlight === 0) {
        process.stderr.write(`[${new Date().toISOString()}] poll: idle\n`);
      } else {
        process.stderr.write(`[${new Date().toISOString()}] poll: ${stats.total} open, ${stats.processing} started, ${stats.inFlight} in-flight\n`);
      }
    } catch (err) {
      clearStatus();
      process.stderr.write(`[${new Date().toISOString()}] Poll error: ${err.message}\n`);
    }

    if (running) {
      await new Promise(resolve => { sleepResolve = resolve; setTimeout(() => { sleepResolve = null; resolve(); }, pollInterval); });
    }
  }

  await runner.waitForInFlight();
  stopStatus();
  console.log(`[${new Date().toISOString()}] Stopped.`);
}
