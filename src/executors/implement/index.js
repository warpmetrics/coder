// Implement executor: resolves issues by generating code with Claude Code.
// Returns typed results — no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from '../../config.js';
import { TIMEOUTS } from '../../defaults.js';
import { fetchComments } from '../../clients/claude-code.js';
import * as warp from '../../clients/warp.js';
import { OUTCOMES, ACTS } from '../../graph/names.js';
import { safeHook } from '../../agent/hooks.js';
import { loadMemory } from '../../agent/memory.js';
import { reflectOnStep } from '../../agent/reflect.js';
import { classifyIntentPrompt, buildImplementPrompt, INTENT_SCHEMA, IntentSchema } from './prompt.js';
import { inferDeployPlan } from '../deploy/release.js';
import { installSkills } from '../../agent/skills.js';
import { gitExclude } from '../../agent/workspace.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function classifyIntent(claudeCode, message, log) {
  try {
    const res = await claudeCode.run({ prompt: classifyIntentPrompt(message), jsonSchema: INTENT_SCHEMA, maxTurns: 10, noSessionPersistence: true, allowedTools: '', timeout: TIMEOUTS.CLAUDE_QUICK, verbose: false });
    let intent = res.structuredOutput?.intent;
    if (!intent) {
      // Fallback: parse from text
      const parsed = IntentSchema.safeParse(typeof res.result === 'string' ? (() => { try { return JSON.parse(res.result); } catch { return null; } })() : res.result);
      if (parsed?.success) intent = parsed.data.intent;
    }
    if (!intent) {
      // Last resort: text matching
      intent = res.result?.trim().toUpperCase().includes('PROPOSE') ? 'PROPOSE' : 'IMPLEMENT';
    }
    const isPropose = intent === 'PROPOSE';
    log(`  classifyIntent: ${intent} → ${isPropose ? 'PROPOSE' : 'IMPLEMENT'}`);
    return isPropose;
  } catch (err) {
    log(`  classifyIntent failed (defaulting to PROPOSE): ${err.message}`);
    return true;
  }
}

function setupWorkspace(git, repos, { workdir, branch, resume }) {
  const dirNames = deriveRepoDirNames(repos);
  const repoDirs = [];

  if (resume && existsSync(workdir)) {
    for (let i = 0; i < repos.length; i++) {
      const dir = join(workdir, dirNames[i]);
      if (i === 0 || existsSync(join(dir, '.git'))) {
        git.setBotIdentity(dir);
        repoDirs.push({ url: repos[i].url, name: repoName(repos[i]), dirName: dirNames[i], dir });
      }
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
  resultTypes: ['success', 'error', 'ask_user'],
  effects: {
    async before(run, ctx) {
      const { config, clients: { notify }, context: { actOpts } } = ctx;
      if (actOpts && 'sessionId' in actOpts) return;
      const primaryRepo = config.repoNames[0];
      notify.comment(run.issueId, { repo: primaryRepo, runId: run.id, title: run.title, body: `Starting implementation...` });
    },
    async success(run, result, ctx) {
      const { config, clients: { notify, issues, log } } = ctx;
      const primaryRepo = config.repoNames[0];
      const resultPrs = result.nextActOpts?.prs || [];

      const prList = resultPrs.map(p => `- ${p.repo}#${p.prNumber}`).join('\n');
      notify.comment(run.issueId, { repo: primaryRepo, runId: run.id, title: run.title, body: `PRs ready for review:\n\n${prList}` });

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
      const { config, clients: { notify, log } } = ctx;
      const primaryRepo = config.repoNames[0];
      const error = result.error || 'Unknown error';
      notify.comment(run.issueId, {
        repo: primaryRepo, runId: run.id, title: run.title,
        body: `<!-- warp-coder:error\n${error}\n-->\n\nImplementation failed — needs human intervention.\n\n<details>\n<summary>Error details</summary>\n\n\`\`\`\n${error}\n\`\`\`\n</details>`,
      });
      log(`posted error comment`);
    },
    async ask_user(run, result, ctx) {
      const { config, clients: { notify, log } } = ctx;
      const primaryRepo = config.repoNames[0];
      const marker = `<!-- warp-coder:question -->`;
      notify.comment(run.issueId, { repo: primaryRepo, runId: run.id, title: run.title, body: `${marker}\n\nNeeds clarification:\n\n${result.question}` });
      log(`posted clarification question`);
    },
  },
  create() {
    return async (run, ctx) => {
      const { config, clients, context } = ctx;
      const item = run.boardItem || { _issueId: run.issueId, content: { title: run.title, body: '', number: run.issueId } };
      const r = await implement(item, { config, clients, context, resumeSession: context.actOpts?.sessionId || undefined });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { ...r.outcomeOpts, issueNumber: run.issueId },
          nextActOpts: { prs: r.prs, release: r.deployPlan?.release || [], sessionId: r.sessionId } };
      }
      if (r.type === 'ask_user') {
        return { ...r, outcomeOpts: { ...r.outcomeOpts, issueNumber: run.issueId },
          nextActOpts: { sessionId: r.sessionId } };
      }
      return { ...r, outcomeOpts: { ...r.outcomeOpts, issueNumber: run.issueId } };
    };
  },
};

export async function implement(item, ctx) {
  const { config, clients: { git, prs, issues, claudeCode, log }, context: { onStep, onBeforeLog }, resumeSession } = ctx;
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

  // Short-circuit: if open PRs already exist for this issue, skip to review.
  if (!resumeSession) {
    const repoNames = repos.map(r => repoName(r));
    const existingPRs = prs.findAllPRs(issueId, repoNames, { branchPattern: branch });
    if (existingPRs.length > 0) {
      log(`  found existing PR(s): ${existingPRs.map(p => `${p.repo}#${p.prNumber}`).join(', ')} — skipping to review`);
      return {
        type: 'success', costUsd: 0, trace: null, sessionId: null,
        prs: existingPRs.map(p => ({ repo: p.repo, prNumber: p.prNumber })),
        deployPlan: null, deployPlanFailed: false,
      };
    }
  }

  // 1. Workspace

  const { repoDirs, dirNames, resumed } = setupWorkspace(git, repos, { workdir, branch, resume: resumeSession });
  if (!resumed) safeHook('onBranchCreate', config, { workdir, issueNumber: issueId, branch, repo: primaryRepo }, hookOutputs);
  log(resumed ? `  resuming in ${workdir}` : `  cloned ${primaryRepo}, branch: ${branch}`);
  const skillCount = installSkills(configDir, workdir);
  if (skillCount) log(`  installed ${skillCount} skill(s)`);

  try {
    // 2. Context
    const { commentsText, lastHumanMessage } = fetchComments(issues, issueId, primaryRepo, log);
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';
    const shouldPropose = await classifyIntent(claudeCode, lastHumanMessage || issueBody, log);

    // 3. Prompt
    const repoUrls = repos.map(r => r.url);
    const prompt = buildImplementPrompt({
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
      logPrefix: `[#${issueId}] [implement]`, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);

    if (result.hitMaxTurns) {
      const question = shouldPropose
        ? 'Ran out of turns before finishing the proposal. Please simplify the request or break it into smaller pieces.'
        : (result.result || 'I ran out of turns before finishing.');
      return { type: 'ask_user', question,
        sessionId: result.sessionId, costUsd: result.costUsd, trace: result.trace,
        outcomeOpts: { name: OUTCOMES.NEEDS_CLARIFICATION } };
    }

    // 5. Proposal check
    if (shouldPropose) {
      return { type: 'ask_user', question: result.result,
        sessionId: result.sessionId, costUsd: result.costUsd, trace: result.trace,
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
      deployPlan = await inferDeployPlan(claudeCode, result.sessionId, prRepos, config.deploy, workdir, { log });
    } catch (err) {
      deployPlanFailed = true;
      log(`  warning: deploy plan inference failed: ${err.message}`);
    }

    reflectOnStep(config, configDir, 'implement', { issue: { number: issueId, title: issueTitle }, success: true, hookOutputs, claudeOutput: result.result }, log, claudeCode);
    return { type: 'success', costUsd: result.costUsd, trace: result.trace, sessionId: result.sessionId, prs: createdPRs.map(p => ({ repo: p.repo, prNumber: p.number })), deployPlan, deployPlanFailed };
  } catch (err) {
    reflectOnStep(config, configDir, 'implement', { issue: { number: issueId, title: issueTitle }, success: false, error: err.message, hookOutputs }, log, claudeCode);
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  }
}
