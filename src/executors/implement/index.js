// Implement executor: resolves issues by generating code with Claude Code.
// Returns typed results — no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from '../../config.js';
import { fetchComments } from '../claude.js';
import * as warp from '../../clients/warp.js';
import { OUTCOMES, ACTS } from '../../names.js';
import { safeHook } from '../../agent/hooks.js';
import { loadMemory } from '../../agent/memory.js';
import { reflect } from '../../agent/reflect.js';
import { classifyIntentPrompt, buildImplementPrompt, IMPLEMENT_RESUME } from './prompt.js';
import { inferDeployPlan } from '../deploy/release.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function classifyIntent(claudeCode, message, { model = 'sonnet' } = {}) {
  try {
    const { result } = await claudeCode.oneShot(classifyIntentPrompt(message), { model, timeout: 15000 });
    return result.trim().toUpperCase().includes('PROPOSE');
  } catch { return false; }
}

function setupWorkspace(git, repos, { workdir, branch, resume }) {
  const dirNames = deriveRepoDirNames(repos);
  const repoDirs = [];

  if (resume && existsSync(workdir)) {
    for (let i = 0; i < repos.length; i++) {
      const dir = join(workdir, dirNames[i]);
      if (i === 0 || existsSync(join(dir, '.git')))
        repoDirs.push({ url: repos[i].url, name: repoName(repos[i]), dirName: dirNames[i], dir });
    }
    return { repoDirs, dirNames, resumed: true };
  }

  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  const dest = join(workdir, dirNames[0]);
  git.clone(repos[0].url, dest);
  if (branch) git.createBranch(dest, branch);
  repoDirs.push({ url: repos[0].url, name: repoName(repos[0]), dirName: dirNames[0], dir: dest });
  return { repoDirs, dirNames, resumed: false };
}

function discoverClonedRepos(repos, dirNames, workdir, repoDirs) {
  for (let i = 1; i < repos.length; i++) {
    const dir = join(workdir, dirNames[i]);
    if (existsSync(join(dir, '.git')) && !repoDirs.some(r => r.dir === dir))
      repoDirs.push({ url: repos[i].url, name: repoName(repos[i]), dirName: dirNames[i], dir });
  }
}

function reflectOnStep(config, configDir, step, opts, log) {
  if (config.memory?.enabled === false) return;
  reflect({ configDir, step, ...opts, hookOutputs: (opts.hookOutputs || []).filter(h => h.ran), maxLines: config.memory?.maxLines || 100 })
    .then(() => log('  reflect: memory updated'))
    .catch(() => {});
}

function gitExclude(dir, entries) {
  const file = join(dir, '.git', 'info', 'exclude');
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  const additions = entries.filter(e => !existing.includes(e));
  if (additions.length) writeFileSync(file, existing.trimEnd() + '\n' + additions.join('\n') + '\n');
}

function pushAndCreatePRs(git, prs, repoDirs, { branch, issueId, issueTitle, primaryRepoName, prActId, config, hookOutputs, log }) {
  let anyChanges = false, primaryPRCreated = false;
  const createdPRs = [];

  for (const { dir, name, dirName } of repoDirs) {
    gitExclude(dir, [...repoDirs.filter(r => r.dir !== dir).map(r => r.dirName), '.warp-coder-ask']);
    if (git.status(dir)) git.commitAll(dir, `Implement #${issueId}: ${issueTitle}`);
    if (git.getCurrentBranch(dir) !== branch && git.hasNewCommits(dir)) git.createBranch(dir, branch);
    if (!git.hasNewCommits(dir)) continue;

    anyChanges = true;
    git.push(dir, branch);

    const inPrimary = name === primaryRepoName;
    const body = [`${!primaryPRCreated ? 'Closes' : 'Part of'} ${inPrimary ? `#${issueId}` : `${primaryRepoName}#${issueId}`}`, '', 'Implemented by warp-coder.', ...(prActId ? ['', `<!-- wm:act:${prActId} -->`] : [])].join('\n');
    const pr = prs.createPR(dir, { title: issueTitle, body, head: branch });
    log(`  ${dirName}: PR #${pr.number}`);
    createdPRs.push({ repo: name, number: pr.number, url: pr.url });
    primaryPRCreated = true;
    safeHook('onPRCreated', config, { workdir: dir, issueNumber: issueId, prNumber: pr.number, branch, repo: name }, hookOutputs);
  }

  return { createdPRs, anyChanges };
}

// ---------------------------------------------------------------------------
// Implement
// ---------------------------------------------------------------------------

export const definition = {
  name: 'implement',
  resultTypes: ['success', 'error', 'ask_user', 'max_turns'],
  effects: {
    async success(run, result, ctx) {
      const { config, clients: { notify, issues }, context: { log } } = ctx;
      const primaryRepo = config.repoNames[0];
      const resultPrs = result.nextActOpts?.prs || [];

      try {
        const prList = resultPrs.map(p => `- ${p.repo}#${p.prNumber}`).join('\n');
        notify.comment(run.issueId, { repo: primaryRepo, runId: run.id, body: `PRs ready for review:\n\n${prList}` });
      } catch {}

      const release = result.nextActOpts?.release || [];
      const repos = release.length > 0
        ? release.map(s => s.repo)
        : resultPrs.map(p => p.repo);
      const labels = [...new Set(repos)].map(r => `deploy:${r.split('/').pop()}`);
      if (labels.length === 0) return;
      try {
        issues.addLabels(run.issueId, labels, { repo: primaryRepo });
        log(`tagged: ${labels.join(', ')}`);
      } catch (err) {
        log(`warning: could not add labels: ${err.message}`);
      }
    },
    async error(run, result, ctx) {
      const { config, clients: { notify }, context: { log } } = ctx;
      const primaryRepo = config.repoNames[0];
      const error = result.error || 'Unknown error';
      try {
        notify.comment(run.issueId, {
          repo: primaryRepo, runId: run.id,
          body: `<!-- warp-coder:error\n${error}\n-->\n\nImplementation failed — needs human intervention.\n\n<details>\n<summary>Error details</summary>\n\n\`\`\`\n${error}\n\`\`\`\n</details>`,
        });
        log(`posted error comment`);
      } catch {}
    },
    async ask_user(run, result, ctx) {
      const { config, clients: { notify }, context: { log } } = ctx;
      const primaryRepo = config.repoNames[0];
      const marker = `<!-- warp-coder:question -->`;
      try { notify.comment(run.issueId, { repo: primaryRepo, runId: run.id, body: `${marker}\n\nNeeds clarification:\n\n${result.question}` }); log(`posted clarification question`); } catch {}
    },
  },
  create() {
    return async (run, ctx) => {
      const { config, clients, context } = ctx;
      const item = run.boardItem || { _issueId: run.issueId, content: { title: run.title, body: '', number: run.issueId } };
      const r = await implement(item, { config, clients, context, resumeSession: context.actOpts?.sessionId || undefined });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { prs: r.prs, release: r.deployPlan?.release || [], sessionId: r.sessionId } };
      }
      if (r.type === 'ask_user') {
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { sessionId: r.sessionId } };
      }
      if (r.type === 'max_turns') {
        const retryCount = (context.actOpts?.retryCount || 0) + 1;
        const limit = config.maxTurnsRetries || 3;
        if (retryCount >= limit) {
          context.log(`max_turns limit reached (${retryCount}/${limit}), giving up`);
          return { type: 'error', error: `Hit max turns ${retryCount} times without completing`, costUsd: r.costUsd, trace: r.trace, outcomeOpts: { issueNumber: run.issueId } };
        }
        return { ...r, outcomeOpts: { issueNumber: run.issueId },
          nextActOpts: { sessionId: r.sessionId, retryCount } };
      }
      return { ...r, outcomeOpts: { issueNumber: run.issueId } };
    };
  },
};

export async function implement(item, ctx) {
  const { config, clients: { git, prs, issues, claudeCode }, context: { log, onStep, onBeforeLog }, resumeSession } = ctx;
  const issueId = item._issueId;
  const issueTitle = item.content?.title || `Issue #${issueId}`;
  const issueBody = item.content?.body || '';
  const repos = config.repos;
  const primaryRepo = repoName(repos[0]);
  const branch = typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`;
  const workdir = join(tmpdir(), 'warp-coder', String(issueId));
  const configDir = join(process.cwd(), CONFIG_DIR);
  const hookOutputs = [];
  const prActReserved = config.warpmetricsApiKey ? warp.reserveAct(ACTS.REVIEW) : null;

  // 1. Workspace

  const { repoDirs, dirNames, resumed } = setupWorkspace(git, repos, { workdir, branch, resume: resumeSession });
  if (!resumed) safeHook('onBranchCreate', config, { workdir, issueNumber: issueId, branch, repo: primaryRepo }, hookOutputs);
  log(resumed ? `  resuming in ${workdir}` : `  cloned ${primaryRepo}, branch: ${branch}`);

  try {
    // 2. Context
    const { commentsText, lastHumanMessage } = fetchComments(issues, issueId, primaryRepo);
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';
    const shouldPropose = await classifyIntent(claudeCode, lastHumanMessage || issueBody, { model: config.quickModel || 'sonnet' });

    // 3. Prompt
    const repoUrls = repos.map(r => r.url);
    const prompt = resumed ? IMPLEMENT_RESUME : buildImplementPrompt({
      workdir, repos: repoUrls, repoNames: repos.map(repoName), dirNames,
      primaryDirName: dirNames[0], primaryRepoName: primaryRepo, branch,
      issueId, issueTitle, issueBody, memory, commentsText, shouldPropose,
    });

    // 4. Claude
    onStep?.('claude');
    const result = await claudeCode.run({
      prompt, workdir,
      resume: resumed ? resumeSession : undefined,
      disallowedTools: config.claude?.disallowedTools || ['Bash(gh *)'],
      logPrefix: `[#${issueId}] `, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);

    if (result.hitMaxTurns) {
      return { type: 'max_turns', sessionId: result.sessionId, costUsd: result.costUsd, trace: result.trace,
        outcomeOpts: { name: OUTCOMES.MAX_RETRIES } };
    }

    // 5. Proposal check
    if (shouldPropose) {
      return { type: 'ask_user', question: result.result, sessionId: result.sessionId,
        costUsd: result.costUsd, trace: result.trace,
        outcomeOpts: { name: OUTCOMES.NEEDS_CLARIFICATION } };
    }

    // 6. Discover repos + push + PRs
    discoverClonedRepos(repos, dirNames, workdir, repoDirs);

    onStep?.('pushing');
    safeHook('onBeforePush', config, { workdir, issueNumber: issueId, branch, repo: primaryRepo }, hookOutputs);
    const { createdPRs, anyChanges } = pushAndCreatePRs(git, prs, repoDirs, {
      branch, issueId, issueTitle, primaryRepoName: primaryRepo, prActId: prActReserved?.id, config, hookOutputs, log,
    });
    if (!anyChanges) throw new Error('No changes were produced');

    // 7. Infer deploy plan (commands from config, dependencies from LLM if multi-repo)
    let deployPlan = null;
    let deployPlanFailed = false;
    try {
      const prRepos = createdPRs.map(p => ({ repo: p.repo }));
      deployPlan = await inferDeployPlan(claudeCode, result.sessionId, prRepos, config.deploy, workdir, { model: config.quickModel || 'sonnet', log });
    } catch (err) {
      deployPlanFailed = true;
      log(`  warning: deploy plan inference failed: ${err.message}`);
    }

    reflectOnStep(config, configDir, 'implement', { issue: { number: issueId, title: issueTitle }, success: true, hookOutputs, claudeOutput: result.result }, log);
    return { type: 'success', costUsd: result.costUsd, trace: result.trace, sessionId: result.sessionId, prs: createdPRs.map(p => ({ repo: p.repo, prNumber: p.number })), deployPlan, deployPlanFailed };
  } catch (err) {
    reflectOnStep(config, configDir, 'implement', { issue: { number: issueId, title: issueTitle }, success: false, error: err.message, hookOutputs }, log);
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  }
}
