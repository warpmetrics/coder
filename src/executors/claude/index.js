// Claude Code executors: implement and revise.
// Pure work functions — return typed results, no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from '../../config.js';
import * as claude from './claude.js';
import * as warp from '../../client/warp.js';
import { OUTCOMES, ACTS } from '../../names.js';
import { safeHook } from '../../agent/hooks.js';
import { loadMemory } from '../../agent/memory.js';
import { reflect } from '../../agent/reflect.js';
import { classifyIntentPrompt, buildImplementPrompt, IMPLEMENT_RESUME, buildRevisePrompt } from '../../prompts.js';
import { inferDeployPlan } from '../../workflows/release.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function classifyIntent(message, { model = 'sonnet' } = {}) {
  try {
    const { execFileSync } = await import('child_process');
    const out = execFileSync('claude', ['-p', classifyIntentPrompt(message), '--max-turns', '1', '--model', model, '--no-session-persistence'], { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim().toUpperCase().includes('PROPOSE');
  } catch { return false; }
}

export function buildTrace(result, startTime) {
  if (!result || !startTime) return null;
  const duration = Date.now() - startTime;
  return {
    provider: 'anthropic', model: 'claude-code', duration,
    startedAt: new Date(startTime).toISOString(),
    endedAt: new Date(startTime + duration).toISOString(),
    cost: result.costUsd,
    status: result.subtype === 'error_max_turns' ? 'error' : 'success',
    opts: { turns: result.numTurns, session_id: result.sessionId },
  };
}

function setupWorkspace(codehost, repos, { workdir, branch, resume }) {
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
  codehost.clone(repos[0].url, dest);
  if (branch) codehost.createBranch(dest, branch);
  repoDirs.push({ url: repos[0].url, name: repoName(repos[0]), dirName: dirNames[0], dir: dest });
  return { repoDirs, dirNames, resumed: false };
}

export async function runClaudeCode(prompt, workdir, config, opts = {}) {
  const start = Date.now();
  const result = await claude.run({
    prompt, workdir,
    allowedTools: config.claude?.allowedTools,
    disallowedTools: opts.disallowedTools,
    maxTurns: config.claude?.maxTurns,
    resume: opts.resume, logPrefix: opts.logPrefix, onBeforeLog: opts.onBeforeLog,
  });
  return { ...result, trace: buildTrace(result, start), hitMaxTurns: result.subtype === 'error_max_turns' };
}

export function fetchComments(codehost, issueId, repo) {
  try {
    const comments = codehost.getIssueComments(issueId, { repo });
    if (!comments.length) return { commentsText: '', lastHumanMessage: null };
    const lastHuman = [...comments].reverse().find(c => !(c.body || '').includes('warp-coder'));
    const strip = s => (s || '').replace(/<!--[\s\S]*?-->\n*/g, '').trim();
    return {
      lastHumanMessage: lastHuman ? strip(lastHuman.body) : null,
      commentsText: comments.map(c => {
        const body = strip(c.body);
        return body ? `**${c.user?.login || 'unknown'}:** ${body}` : null;
      }).filter(Boolean).join('\n\n'),
    };
  } catch { return { commentsText: '', lastHumanMessage: null }; }
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

// ---------------------------------------------------------------------------
// Implement
// ---------------------------------------------------------------------------

export async function implement(item, { config, codehost, log, onStep, onBeforeLog, resumeSession }) {
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
  let preserveWorkdir = false;

  // 1. Workspace

  const { repoDirs, dirNames, resumed } = setupWorkspace(codehost, repos, { workdir, branch, resume: resumeSession });
  if (!resumed) safeHook('onBranchCreate', config, { workdir, issueNumber: issueId, branch, repo: primaryRepo }, hookOutputs);
  log(resumed ? `  resuming in ${workdir}` : `  cloned ${primaryRepo}, branch: ${branch}`);

  try {
    // 2. Context
    const { commentsText, lastHumanMessage } = fetchComments(codehost, issueId, primaryRepo);
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';
    const shouldPropose = await classifyIntent(lastHumanMessage || issueBody, { model: config.quickModel || 'sonnet' });

    // 3. Prompt
    const repoUrls = repos.map(r => r.url);
    const prompt = resumed ? IMPLEMENT_RESUME : buildImplementPrompt({
      workdir, repos: repoUrls, repoNames: repos.map(repoName), dirNames,
      primaryDirName: dirNames[0], primaryRepoName: primaryRepo, branch,
      issueId, issueTitle, issueBody, memory, commentsText, shouldPropose,
    });

    // 4. Claude
    onStep?.('claude');
    const result = await runClaudeCode(prompt, workdir, config, {
      resume: resumed ? resumeSession : undefined,
      disallowedTools: config.claude?.disallowedTools || ['Bash(gh *)'],
      logPrefix: `[#${issueId}] `, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);

    if (result.hitMaxTurns) {
      preserveWorkdir = true;
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
    const { createdPRs, anyChanges } = pushAndCreatePRs(codehost, repoDirs, {
      branch, issueId, issueTitle, primaryRepoName: primaryRepo, prActId: prActReserved?.id, config, hookOutputs, log,
    });
    if (!anyChanges) throw new Error('No changes were produced');

    // 7. Infer deploy plan (commands from config, dependencies from LLM if multi-repo)
    let deployPlan = null;
    let deployPlanFailed = false;
    try {
      const prRepos = createdPRs.map(p => ({ repo: p.repo }));
      deployPlan = inferDeployPlan(result.sessionId, prRepos, config.deploy, workdir, { model: config.quickModel || 'sonnet', log });
    } catch (err) {
      deployPlanFailed = true;
      log(`  warning: deploy plan inference failed: ${err.message}`);
    }

    try { codehost.botComment(issueId, { repo: primaryRepo, body: `PRs ready for review:\n\n${createdPRs.map(p => `- ${p.repo}#${p.number}`).join('\n')}` }); } catch {}
    reflectOnStep(config, configDir, 'implement', { issue: { number: issueId, title: issueTitle }, success: true, hookOutputs, claudeOutput: result.result }, log);
    return { type: 'success', costUsd: result.costUsd, trace: result.trace, prs: createdPRs.map(p => ({ repo: p.repo, prNumber: p.number })), deployPlan, deployPlanFailed };
  } catch (err) {
    reflectOnStep(config, configDir, 'implement', { issue: { number: issueId, title: issueTitle }, success: false, error: err.message, hookOutputs }, log);
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  } finally {
    if (!preserveWorkdir) rmSync(workdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Revise
// ---------------------------------------------------------------------------

export async function revise(item, { config, codehost, log, since, onStep, onBeforeLog }) {
  const issueId = item._issueId;
  const prs = item._prs || [];
  const primaryRepo = prs[0]?.repo || repoName(config.repos[0]);
  const primaryPRNumber = prs[0]?.prNumber || item._prNumber || item.content?.number;
  const repos = config.repos;
  const workdir = join(tmpdir(), 'warp-coder', `revise-${issueId}`);
  const configDir = join(process.cwd(), CONFIG_DIR);
  const prActReserved = config.warpmetricsApiKey ? warp.reserveAct(ACTS.REVIEW) : null;
  const hookOutputs = [];

  // Revision limit
  if (config.warpmetricsApiKey && primaryPRNumber) {
    try {
      const count = await warp.countRevisions(config.warpmetricsApiKey, { prNumber: primaryPRNumber, repo: primaryRepo, since });
      if (count >= (config.maxRevisions || 3))
        return { type: 'max_retries', count, costUsd: null, trace: null };
      log(`  revision ${count + 1}/${config.maxRevisions || 3}`);
    } catch {}
  }

  try {
    // 1. Clone PR branches

    onStep?.('cloning');
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    const dirNames = deriveRepoDirNames(repos);
    const prLookup = new Map(prs.map(p => [p.repo, { prNumber: p.prNumber, branch: codehost.getPRBranch(p.prNumber, { repo: p.repo }) }]));
    const repoDirs = [], contextRepos = [], headsBefore = new Map();

    for (let i = 0; i < repos.length; i++) {
      const url = repos[i].url, name = repoName(repos[i]), dirName = dirNames[i], dest = join(workdir, dirName);
      const pr = prLookup.get(name);
      if (pr) {
        codehost.clone(url, dest, { branch: pr.branch });
        repoDirs.push({ url, name, dirName, dir: dest, prNumber: pr.prNumber, branch: pr.branch, hasPR: true });
        headsBefore.set(dest, codehost.getHead(dest));
        log(`  cloned ${name} (branch: ${pr.branch})`);
      } else {
        contextRepos.push({ url, name, dirName });
      }
    }

    // 2. Reviews + prompt
    const { reviewSection, reviewComments } = fetchReviews(codehost, prs, log);
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';
    const prompt = buildRevisePrompt({ repoDirs, contextRepos, memory, reviewSection });

    // 3. Claude
    onStep?.('claude');
    const result = await runClaudeCode(prompt, workdir, config, { logPrefix: `[#${issueId}] `, onBeforeLog });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);
    if (result.hitMaxTurns) throw new Error(`Hit turn limit (${result.numTurns})`);

    // 4. Push
    onStep?.('pushing');
    safeHook('onBeforePush', config, { workdir, prNumber: primaryPRNumber, branch: repoDirs.find(r => r.hasPR)?.branch, repo: primaryRepo }, hookOutputs);
    const anyChanges = pushRevisionChanges(codehost, repoDirs, headsBefore, log);
    if (prActReserved) updatePRActIds(codehost, repoDirs, prActReserved.id, log);

    if (!anyChanges) {
      log('  no changes needed — dismissing stale reviews');
      dismissStaleReviews(codehost, prs, log);
      for (const rd of repoDirs) {
        if (!rd.hasPR) continue;
        codehost.commitAll(rd.dir, 'Verified correct — review feedback already addressed', { allowEmpty: true });
        codehost.push(rd.dir, rd.branch);
      }
    }

    reflectOnStep(config, configDir, 'revise', { prNumber: primaryPRNumber, success: true, hookOutputs, reviewComments, claudeOutput: result.result }, log);
    return { type: 'success', costUsd: result.costUsd, trace: result.trace };
  } catch (err) {
    reflectOnStep(config, configDir, 'revise', { prNumber: primaryPRNumber, success: false, error: err.message, hookOutputs }, log);
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Git helpers (shared)
// ---------------------------------------------------------------------------

function pushAndCreatePRs(codehost, repoDirs, { branch, issueId, issueTitle, primaryRepoName, prActId, config, hookOutputs, log }) {
  let anyChanges = false, primaryPRCreated = false;
  const createdPRs = [];

  for (const { dir, name, dirName } of repoDirs) {
    gitExclude(dir, [...repoDirs.filter(r => r.dir !== dir).map(r => r.dirName), '.warp-coder-ask']);
    if (codehost.status(dir)) codehost.commitAll(dir, `Implement #${issueId}: ${issueTitle}`);
    if (codehost.getCurrentBranch(dir) !== branch && codehost.hasNewCommits(dir)) codehost.createBranch(dir, branch);
    if (!codehost.hasNewCommits(dir)) continue;

    anyChanges = true;
    codehost.push(dir, branch);

    const inPrimary = name === primaryRepoName;
    const body = [`${!primaryPRCreated ? 'Closes' : 'Part of'} ${inPrimary ? `#${issueId}` : `${primaryRepoName}#${issueId}`}`, '', 'Implemented by warp-coder.', ...(prActId ? ['', `<!-- wm:act:${prActId} -->`] : [])].join('\n');
    const pr = codehost.createPR(dir, { title: issueTitle, body, head: branch });
    log(`  ${dirName}: PR #${pr.number}`);
    createdPRs.push({ repo: name, number: pr.number, url: pr.url });
    primaryPRCreated = true;
    safeHook('onPRCreated', config, { workdir: dir, issueNumber: issueId, prNumber: pr.number, branch, repo: name }, hookOutputs);
  }

  return { createdPRs, anyChanges };
}

function pushRevisionChanges(codehost, repoDirs, headsBefore, log) {
  let any = false;
  for (const rd of repoDirs) {
    if (!rd.hasPR) continue;
    gitExclude(rd.dir, ['.warp-coder-ask']);
    if (codehost.status(rd.dir)) codehost.commitAll(rd.dir, 'Address review feedback');
    if (codehost.getHead(rd.dir) === headsBefore.get(rd.dir)) { log(`  ${rd.dirName}: no changes`); continue; }
    any = true;
    log(`  ${rd.dirName}: pushing`);
    codehost.push(rd.dir, rd.branch);
  }
  return any;
}

function fetchReviews(codehost, prs, log) {
  const reviews = [], inline = [];
  for (const { repo, prNumber } of prs) {
    try { reviews.push(...codehost.getReviews(prNumber, { repo }).map(r => ({ ...r, _repo: repo, _prNumber: prNumber }))); } catch {}
    try { inline.push(...codehost.getReviewComments(prNumber, { repo }).map(c => ({ ...c, _repo: repo, _prNumber: prNumber }))); } catch {}
  }

  const multi = prs.length > 1;
  let s = reviews.filter(r => (r.body || '').trim()).map(r =>
    `${multi ? `[${r._repo}#${r._prNumber}] ` : ''}**${r.user?.login || 'unknown'}** (${r.state || 'COMMENT'}):\n${(r.body || '').trim()}`
  ).join('\n\n');

  if (inline.length) {
    s += '\n\n### Inline comments\n\n' + inline.filter(c => (c.body || '').trim()).map(c => {
      const loc = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\` — ` : '';
      return `${multi ? `[${c._repo}] ` : ''}${loc}**${c.user?.login || 'unknown'}**:\n${(c.body || '').trim()}`;
    }).join('\n\n');
  }

  if (s.length > 20000) s = s.slice(0, 20000) + '\n(truncated)\n';
  return { reviewSection: s, reviewComments: reviews };
}

function updatePRActIds(codehost, repoDirs, prActId, log) {
  for (const rd of repoDirs) {
    if (!rd.hasPR) continue;
    try {
      let body = codehost.getPRBody(rd.prNumber, { repo: rd.name });
      body = body.replace(/<!-- wm:act:wm_act_\w+ -->/, `<!-- wm:act:${prActId} -->`);
      if (!body.includes(`<!-- wm:act:${prActId} -->`)) body += `\n\n<!-- wm:act:${prActId} -->`;
      codehost.updatePRBody(rd.prNumber, { repo: rd.name, body });
    } catch {}
  }
}

function dismissStaleReviews(codehost, prs, log) {
  for (const { repo, prNumber } of prs) {
    try {
      for (const r of codehost.getReviews(prNumber, { repo }))
        if (r.state === 'CHANGES_REQUESTED') { codehost.dismissReview(prNumber, r.id, { repo, message: 'Code verified — no changes needed.' }); log(`  dismissed review ${r.id}`); }
    } catch {}
  }
}
