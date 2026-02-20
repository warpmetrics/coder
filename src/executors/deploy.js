// Deploy executor: clones repos, merges DAGs from batched issues,
// topo-sorts, and runs deploy scripts in dependency order.

import { execSync as defaultExecSync } from 'child_process';
import { existsSync as defaultExistsSync, rmSync as defaultRmSync, mkdirSync as defaultMkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeDAGs, topoSort, buildSteps } from '../workflows/plan.js';

/**
 * Build plan inputs from actOpts and optional deployBatch.
 * Returns array of plan objects suitable for mergeDAGs().
 */
function buildPlans(actOpts, deployBatch) {
  if (deployBatch?.issues?.length) {
    return deployBatch.issues.map(issue => ({
      issueId: issue.issueId,
      releaseSteps: issue.releaseSteps || [],
      releaseDAG: issue.releaseDAG || {},
    }));
  }
  return [{
    issueId: actOpts?.issueId,
    releaseSteps: actOpts?.releaseSteps || [],
    releaseDAG: actOpts?.releaseDAG || {},
  }];
}

export async function deploy(actOpts, { codehost, deployBatch, log, exec: execSync = defaultExecSync, fs: _fs } = {}) {
  const existsSync = _fs?.existsSync ?? defaultExistsSync;
  const rmSync = _fs?.rmSync ?? defaultRmSync;
  const mkdirSync = _fs?.mkdirSync ?? defaultMkdirSync;

  function cleanup(workdir) {
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  }

  function runStep(step, clonedRepos) {
    const short = step.repo.split('/').pop();
    if (!step.script) {
      log(`[${short}] no script — skipping`);
      return { ok: true };
    }
    const repoDir = clonedRepos.get(step.repo);
    if (!repoDir) return { error: `${step.repo} not cloned` };

    log(`[${short}] running: ${step.script}`);
    const start = Date.now();
    try {
      execSync(step.script, { cwd: repoDir, stdio: 'pipe', timeout: 10 * 60 * 1000 });
      log(`[${short}] done (${Math.round((Date.now() - start) / 1000)}s)`);
      return { ok: true };
    } catch (err) {
      return { error: `Deploy failed for ${step.repo}: ${err.message}` };
    }
  }

  // 1. Build merged plan from batch (or single issue)
  const plans = buildPlans(actOpts, deployBatch);
  const merged = mergeDAGs(plans);
  const ordered = topoSort(merged.dag);
  if (!ordered) return { type: 'error', error: 'Circular dependency in deploy DAG' };
  const steps = buildSteps(ordered, merged);

  if (steps.length === 0) return { type: 'error', error: 'No deploy steps found' };

  // 2. Log the plan
  for (const step of steps) {
    const short = step.repo.split('/').pop();
    log(`  step: ${short} — ${step.script || 'no script'}`);
  }

  // 3. Clone repos
  const workdir = join(tmpdir(), 'warp-coder', 'deploy');
  if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  const clonedRepos = new Map();
  for (const step of steps) {
    if (clonedRepos.has(step.repo)) continue;
    const short = step.repo.split('/').pop();
    const dest = join(workdir, short);
    log(`cloning ${step.repo}...`);
    try {
      codehost.clone(`git@github.com:${step.repo}.git`, dest);
      clonedRepos.set(step.repo, dest);
    } catch (err) {
      cleanup(workdir);
      return { type: 'error', error: `Clone failed for ${step.repo}: ${err.message}` };
    }
  }

  // 4. Execute steps by level (sequential across levels, parallel within level)
  const byLevel = new Map();
  for (const step of steps) {
    if (!byLevel.has(step.level)) byLevel.set(step.level, []);
    byLevel.get(step.level).push(step);
  }

  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    const levelSteps = byLevel.get(level);
    const results = await Promise.all(levelSteps.map(step => runStep(step, clonedRepos)));
    const failed = results.find(r => r.error);
    if (failed) {
      cleanup(workdir);
      return { type: 'error', error: failed.error };
    }
  }

  // 5. Cleanup
  cleanup(workdir);
  return { type: 'success', steps };
}
