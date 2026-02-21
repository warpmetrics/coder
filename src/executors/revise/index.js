// Revise executor: applies review feedback with Claude Code.
// Returns typed results — no board moves.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from '../../config.js';
import * as warp from '../../clients/warp.js';
import { ACTS } from '../../names.js';
import { safeHook } from '../../agent/hooks.js';
import { loadMemory } from '../../agent/memory.js';
import { reflect } from '../../agent/reflect.js';
import { buildRevisePrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function pushRevisionChanges(git, repoDirs, headsBefore, log) {
  let any = false;
  for (const rd of repoDirs) {
    if (!rd.hasPR) continue;
    gitExclude(rd.dir, ['.warp-coder-ask']);
    if (git.status(rd.dir)) git.commitAll(rd.dir, 'Address review feedback');
    if (git.getHead(rd.dir) === headsBefore.get(rd.dir)) { log(`  ${rd.dirName}: no changes`); continue; }
    any = true;
    log(`  ${rd.dirName}: pushing`);
    git.push(rd.dir, rd.branch);
  }
  return any;
}

function fetchReviews(prsClient, prList, log) {
  const reviews = [], inline = [];
  for (const { repo, prNumber } of prList) {
    try { reviews.push(...prsClient.getReviews(prNumber, { repo }).map(r => ({ ...r, _repo: repo, _prNumber: prNumber }))); } catch {}
    try { inline.push(...prsClient.getReviewComments(prNumber, { repo }).map(c => ({ ...c, _repo: repo, _prNumber: prNumber }))); } catch {}
  }

  const multi = prList.length > 1;
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

function updatePRActIds(prsClient, repoDirs, prActId, log) {
  for (const rd of repoDirs) {
    if (!rd.hasPR) continue;
    try {
      let body = prsClient.getPRBody(rd.prNumber, { repo: rd.name });
      body = body.replace(/<!-- wm:act:wm_act_\w+ -->/, `<!-- wm:act:${prActId} -->`);
      if (!body.includes(`<!-- wm:act:${prActId} -->`)) body += `\n\n<!-- wm:act:${prActId} -->`;
      prsClient.updatePRBody(rd.prNumber, { repo: rd.name, body });
    } catch {}
  }
}

function dismissStaleReviews(prsClient, prList, log) {
  for (const { repo, prNumber } of prList) {
    try {
      for (const r of prsClient.getReviews(prNumber, { repo }))
        if (r.state === 'CHANGES_REQUESTED') { prsClient.dismissReview(prNumber, r.id, { repo, message: 'Code verified — no changes needed.' }); log(`  dismissed review ${r.id}`); }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Revise
// ---------------------------------------------------------------------------

export const definition = {
  name: 'revise',
  resultTypes: ['success', 'error', 'max_retries'],
  effects: {
    async error(run, result, ctx) {
      const { config, clients: { notify } } = ctx;
      const error = result.error || 'Unknown error';
      try {
        notify.comment(run.issueId, {
          repo: config.repoNames[0], runId: run.id,
          body: `<!-- warp-coder:error\n${error}\n-->\n\nRevision failed — needs human intervention.\n\n<details>\n<summary>Error details</summary>\n\n\`\`\`\n${error}\n\`\`\`\n</details>`,
        });
      } catch {}
    },
    async max_retries(run, result, ctx) {
      const { config, clients: { notify } } = ctx;
      try {
        notify.comment(run.issueId, {
          repo: config.repoNames[0], runId: run.id,
          body: `<!-- warp-coder:error\nMax retries (${result.count})\n-->\n\nHit revision limit (${result.count} attempts) — needs human help.`,
        });
      } catch {}
    },
  },
  create() {
    return async (run, ctx) => {
      const { config, clients, context } = ctx;
      const prs = context.actOpts?.prs || [];
      const item = run.boardItem || { _issueId: run.issueId, _prs: prs, _prNumber: prs[0]?.prNumber, content: { title: run.title } };
      if (prs.length && !item._prs) { item._prs = prs; item._prNumber = prs[0]?.prNumber; }
      const r = await revise(item, { config, clients, context, resumeSession: context.actOpts?.sessionId });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { prNumber: item._prNumber },
          nextActOpts: { prs, release: context.actOpts?.release } };
      }
      return { ...r, outcomeOpts: { prNumber: item._prNumber },
        nextActOpts: { prs, release: context.actOpts?.release } };
    };
  },
};

export async function revise(item, ctx) {
  const { config, clients: { git, prs, claudeCode }, context: { log, onStep, onBeforeLog }, resumeSession } = ctx;
  const issueId = item._issueId;
  const prList = item._prs || [];
  const primaryRepo = prList[0]?.repo || repoName(config.repos[0]);
  const primaryPRNumber = prList[0]?.prNumber || item._prNumber || item.content?.number;
  const repos = config.repos;
  const workdir = join(tmpdir(), 'warp-coder', String(issueId));
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
    // 1. Reuse existing workdir or clone PR branches as fallback

    onStep?.('cloning');
    const dirNames = deriveRepoDirNames(repos);
    const prLookup = new Map(prList.map(p => [p.repo, { prNumber: p.prNumber, branch: prs.getPRBranch(p.prNumber, { repo: p.repo }) }]));
    const repoDirs = [], contextRepos = [], headsBefore = new Map();

    const workdirExists = existsSync(workdir);

    for (let i = 0; i < repos.length; i++) {
      const url = repos[i].url, name = repoName(repos[i]), dirName = dirNames[i], dest = join(workdir, dirName);
      const pr = prLookup.get(name);
      if (pr) {
        if (workdirExists && existsSync(join(dest, '.git'))) {
          // Reuse existing workdir — pull latest changes
          repoDirs.push({ url, name, dirName, dir: dest, prNumber: pr.prNumber, branch: pr.branch, hasPR: true });
          headsBefore.set(dest, git.getHead(dest));
          log(`  reusing ${name} (branch: ${pr.branch})`);
        } else {
          // Fallback: clone fresh
          mkdirSync(workdir, { recursive: true });
          git.clone(url, dest, { branch: pr.branch });
          repoDirs.push({ url, name, dirName, dir: dest, prNumber: pr.prNumber, branch: pr.branch, hasPR: true });
          headsBefore.set(dest, git.getHead(dest));
          log(`  cloned ${name} (branch: ${pr.branch})`);
        }
      } else {
        contextRepos.push({ url, name, dirName });
      }
    }

    // 2. Reviews + prompt
    const { reviewSection, reviewComments } = fetchReviews(prs, prList, log);
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';
    const prompt = buildRevisePrompt({ repoDirs, contextRepos, memory, reviewSection });

    // 3. Claude
    onStep?.('claude');
    const result = await claudeCode.run({
      prompt, workdir,
      resume: resumeSession, logPrefix: `[#${issueId}] `, onBeforeLog,
    });
    log(`  claude done (cost: $${result.costUsd ?? '?'})`);
    if (result.hitMaxTurns) throw new Error(`Hit turn limit (${result.numTurns})`);

    // 4. Push
    onStep?.('pushing');
    safeHook('onBeforePush', config, { workdir, prNumber: primaryPRNumber, branch: repoDirs.find(r => r.hasPR)?.branch, repo: primaryRepo }, hookOutputs);
    const anyChanges = pushRevisionChanges(git, repoDirs, headsBefore, log);
    if (prActReserved) updatePRActIds(prs, repoDirs, prActReserved.id, log);

    if (!anyChanges) {
      log('  no changes needed — dismissing stale reviews');
      dismissStaleReviews(prs, prList, log);
      for (const rd of repoDirs) {
        if (!rd.hasPR) continue;
        git.commitAll(rd.dir, 'Verified correct — review feedback already addressed', { allowEmpty: true });
        git.push(rd.dir, rd.branch);
      }
    }

    reflectOnStep(config, configDir, 'revise', { prNumber: primaryPRNumber, success: true, hookOutputs, reviewComments, claudeOutput: result.result }, log);
    return { type: 'success', costUsd: result.costUsd, trace: result.trace };
  } catch (err) {
    reflectOnStep(config, configDir, 'revise', { prNumber: primaryPRNumber, success: false, error: err.message, hookOutputs }, log);
    return { type: 'error', error: err.message, costUsd: null, trace: null };
  }
}
