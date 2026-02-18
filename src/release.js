// Release command: analyzes shipped issues, builds a dependency-ordered
// release plan, and executes it (packages before services, migrations first).

import { execFileSync, execSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from './config.js';
import * as warp from './warp.js';
import * as git from './git.js';
import { createChangelogProvider, PUBLIC_PROMPT, PRIVATE_PROMPT, generateChangelogEntry } from './changelog.js';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ---------------------------------------------------------------------------
// Phase A: Ship-time analysis (called from processMerge)
// ---------------------------------------------------------------------------

/**
 * Analyze repos touched by merged PRs and produce release metadata.
 * Returns opts suitable for closeIssueRun().
 */
export function analyzeRelease(prs, repoNames) {
  const prList = prs.map(p => `${p.repo}#${p.prNumber}`).join(',');

  // Unique repos from merged PRs
  const repoSet = new Set(prs.map(p => p.repo));
  const repos = [...repoSet];

  // Classify each repo
  const repoInfos = [];
  for (const repo of repos) {
    const info = classifyRepo(repo);
    info.repo = repo;

    // Check for migrations in any PR touching this repo
    const repoPrs = prs.filter(p => p.repo === repo);
    info.hasMigrations = repoPrs.some(p => detectMigrations(p.prNumber, p.repo));

    repoInfos.push(info);
  }

  const dag = buildDAG(repoInfos);

  return {
    prs: prList,
    release_steps: JSON.stringify(repoInfos.map(r => ({
      repo: r.repo,
      type: r.type,
      script: r.script,
      hasMigrations: r.hasMigrations,
    }))),
    release_dag: JSON.stringify(dag),
  };
}

/**
 * Fetch package.json from a repo's default branch and classify it.
 */
export function classifyRepo(repoFullName) {
  let pkg = null;
  try {
    const raw = gh(['api', `repos/${repoFullName}/contents/package.json`, '--jq', '.content']);
    pkg = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  } catch {
    return { type: 'unknown', script: null, deps: [] };
  }

  const scripts = pkg.scripts || {};
  const deps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ].filter(d => d.startsWith('@warpmetrics/'));

  // Classify by available scripts
  if (scripts['deploy:prod'] || scripts['deploy:staging']) {
    return {
      type: 'service',
      script: scripts['deploy:prod'] ? 'npm run deploy:prod' : 'npm run deploy:staging',
      deps,
    };
  }

  if (scripts['release:patch'] || scripts['release']) {
    return {
      type: 'package',
      script: scripts['release:patch'] ? 'npm run release:patch' : 'npm run release',
      deps,
    };
  }

  return { type: 'unknown', script: null, deps };
}

/**
 * Check if a PR includes Prisma migration files.
 */
export function detectMigrations(prNumber, repo) {
  try {
    const files = git.getPRFiles(prNumber, { repo });
    return files.some(f => f.path?.includes('prisma/migrations/'));
  } catch {
    return false;
  }
}

/**
 * Build a dependency DAG: { repo: [repos it must wait for] }.
 * Rules:
 * - Package repos that are @warpmetrics/* deps of service repos → package before service
 * - api before frontend (when both present)
 */
export function buildDAG(repoInfos) {
  const dag = {};
  const reposByShortName = new Map(); // "warp" → full repo name
  const reposByPkgName = new Map();   // "@warpmetrics/warp" → full repo name

  for (const info of repoInfos) {
    dag[info.repo] = [];
    const short = info.repo.split('/').pop();
    reposByShortName.set(short, info.repo);
  }

  // Map package names to repos (best-effort from repo short name)
  for (const info of repoInfos) {
    if (info.type === 'package') {
      const short = info.repo.split('/').pop();
      // Common convention: @warpmetrics/short-name
      reposByPkgName.set(`@warpmetrics/${short}`, info.repo);
    }
  }

  // Package → service dependency edges
  for (const info of repoInfos) {
    if (info.type === 'service' && info.deps) {
      for (const dep of info.deps) {
        const depRepo = reposByPkgName.get(dep);
        if (depRepo && depRepo !== info.repo) {
          dag[info.repo].push(depRepo);
        }
      }
    }
  }

  // api before frontend (convention)
  const apiRepo = reposByShortName.get('api');
  const frontendRepo = reposByShortName.get('frontend');
  if (apiRepo && frontendRepo && dag[frontendRepo]) {
    if (!dag[frontendRepo].includes(apiRepo)) {
      dag[frontendRepo].push(apiRepo);
    }
  }

  return dag;
}

// ---------------------------------------------------------------------------
// Phase B: Release command (CLI entry point)
// ---------------------------------------------------------------------------

export async function release() {
  const config = loadConfig();
  const apiKey = config.warpmetricsApiKey;

  if (!apiKey) {
    console.error('Error: warpmetricsApiKey not set in config. Release command requires WarpMetrics.');
    process.exit(1);
  }

  console.log('');
  console.log('  Fetching shipped issues from WarpMetrics...');

  const shipped = await warp.findShippedIssues(apiKey);

  if (shipped.length === 0) {
    console.log('  No shipped issues found. Nothing to release.');
    console.log('');
    return;
  }

  console.log(`  Found ${shipped.length} shipped issue(s)`);

  // Parse release metadata from each shipped issue
  const plans = [];
  for (const issue of shipped) {
    const parsed = parseReleaseOpts(issue.shippedOutcome);
    if (parsed) {
      plans.push({ issue, ...parsed });
    } else {
      // Fallback: shipped before this feature — try to discover from PRs
      const fallback = await discoverReleaseFromPRs(issue);
      if (fallback) {
        plans.push({ issue, ...fallback });
      } else {
        console.log(`  Skipping issue ${issue.opts?.issue ? '#' + issue.opts.issue : issue.runId}: no release metadata`);
      }
    }
  }

  if (plans.length === 0) {
    console.log('  No releasable issues found.');
    console.log('');
    return;
  }

  // Merge DAGs across issues into a single release plan
  const merged = mergeDAGs(plans);

  // Compute topological order
  const ordered = topoSort(merged.dag);
  if (!ordered) {
    console.error('  Error: circular dependency detected in release DAG. Aborting.');
    process.exit(1);
  }

  // Build step list
  const steps = buildSteps(ordered, merged);

  // Present the plan
  formatPlan(steps, plans);

  // Confirm
  const confirmed = await confirm('  Execute? [y/N] ');
  if (!confirmed) {
    console.log('  Aborted.');
    console.log('');
    return;
  }

  // Start Release run in WarpMetrics, linked to the first Release act
  let releaseRunId = null;
  try {
    const refActId = plans.find(p => p.issue.releaseActId)?.issue.releaseActId || null;
    const repos = steps.map(s => s.repo);
    const { runId } = await warp.startReleaseRun(apiKey, { refActId, repos });
    releaseRunId = runId;
    console.log(`  Release run: ${releaseRunId}`);
  } catch (err) {
    console.log(`  Warning: could not create release run: ${err.message}`);
  }

  // Execute with per-step WarpMetrics tracking
  console.log('');
  const success = await executePlan(steps, { apiKey, releaseRunId });

  // Record overall outcome on the Release run
  if (releaseRunId) {
    try {
      const name = success ? 'Released' : 'Release Failed';
      const opts = {
        status: success ? 'success' : 'failure',
        step: 'release',
        repos: steps.map(s => s.repo).join(','),
      };
      await warp.sendEvents(apiKey, {
        outcomes: [{ id: warp.generateId('oc'), refId: releaseRunId, name, opts, timestamp: new Date().toISOString() }],
      });
    } catch {}
  }

  // Record outcome on each Issue run
  const issueName = success ? 'Released' : 'Release Failed';
  for (const plan of plans) {
    try {
      await warp.closeIssueRun(apiKey, {
        runId: plan.issue.runId,
        name: issueName,
        opts: { released_at: new Date().toISOString() },
      });
    } catch (err) {
      console.log(`  Warning: could not record ${issueName} on ${plan.issue.runId}: ${err.message}`);
    }
  }

  console.log('');
  if (success) {
    const notes = buildReleaseNotes(plans, steps);
    console.log(notes);
    console.log('  Released outcome recorded.');

    // Generate and publish changelog entries
    await publishChangelog(config, plans, steps);
  } else {
    console.log('  Release stopped due to failure. Fix the issue and re-run.');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Parsing and merging
// ---------------------------------------------------------------------------

function parseReleaseOpts(outcome) {
  const opts = outcome?.opts;
  if (!opts?.release_steps) return null;

  try {
    return {
      releaseSteps: JSON.parse(opts.release_steps),
      releaseDAG: JSON.parse(opts.release_dag || '{}'),
    };
  } catch {
    return null;
  }
}

async function discoverReleaseFromPRs(issue) {
  // Fallback for issues shipped before this feature
  const prList = issue.shippedOutcome?.opts?.prs;
  if (!prList) return null;

  const prs = prList.split(',').map(s => {
    const [repo, num] = s.trim().split('#');
    return { repo, prNumber: parseInt(num, 10) };
  }).filter(p => p.repo && p.prNumber);

  if (prs.length === 0) return null;

  const repoSet = new Set(prs.map(p => p.repo));
  const repoInfos = [];

  for (const repo of repoSet) {
    const info = classifyRepo(repo);
    info.repo = repo;
    const repoPrs = prs.filter(p => p.repo === repo);
    info.hasMigrations = repoPrs.some(p => detectMigrations(p.prNumber, p.repo));
    repoInfos.push(info);
  }

  return {
    releaseSteps: repoInfos.map(r => ({
      repo: r.repo,
      type: r.type,
      script: r.script,
      hasMigrations: r.hasMigrations,
    })),
    releaseDAG: buildDAG(repoInfos),
  };
}

function mergeDAGs(plans) {
  const allSteps = new Map(); // repo → step info (merged)
  const dag = {};
  const issuesByRepo = new Map(); // repo → Set of issue numbers

  for (const plan of plans) {
    const issueNum = plan.issue.opts?.issue;

    for (const step of plan.releaseSteps) {
      if (!allSteps.has(step.repo)) {
        allSteps.set(step.repo, { ...step });
        dag[step.repo] = [];
        issuesByRepo.set(step.repo, new Set());
      } else {
        // Merge: if any PR has migrations, flag it
        const existing = allSteps.get(step.repo);
        if (step.hasMigrations) existing.hasMigrations = true;
      }
      if (issueNum) issuesByRepo.get(step.repo).add(issueNum);
    }

    // Merge DAG edges
    for (const [repo, deps] of Object.entries(plan.releaseDAG)) {
      if (!dag[repo]) dag[repo] = [];
      for (const dep of deps) {
        if (!dag[repo].includes(dep)) {
          dag[repo].push(dep);
        }
      }
    }
  }

  return { steps: allSteps, dag, issuesByRepo };
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

function topoSort(dag) {
  const nodes = Object.keys(dag);
  const visited = new Set();
  const visiting = new Set();
  const order = [];

  function visit(node) {
    if (visited.has(node)) return true;
    if (visiting.has(node)) return false; // cycle
    visiting.add(node);
    for (const dep of (dag[node] || [])) {
      if (nodes.includes(dep) && !visit(dep)) return false;
    }
    visiting.delete(node);
    visited.add(node);
    order.push(node);
    return true;
  }

  for (const node of nodes) {
    if (!visit(node)) return null; // cycle detected
  }

  return order;
}

// ---------------------------------------------------------------------------
// Step building and display
// ---------------------------------------------------------------------------

function buildSteps(ordered, merged) {
  const steps = [];
  // Group by DAG level for parallel execution info
  const levels = computeLevels(ordered, merged.dag);

  for (const repo of ordered) {
    const info = merged.steps.get(repo);
    const issues = merged.issuesByRepo.get(repo);
    const level = levels.get(repo);

    steps.push({
      repo,
      type: info?.type || 'unknown',
      script: info?.script,
      hasMigrations: info?.hasMigrations || false,
      issues: issues ? [...issues] : [],
      level,
      dependsOn: (merged.dag[repo] || []).filter(d => merged.steps.has(d)),
    });
  }

  return steps;
}

function computeLevels(ordered, dag) {
  const levels = new Map();
  for (const repo of ordered) {
    const deps = (dag[repo] || []).filter(d => levels.has(d));
    const maxDepLevel = deps.length > 0 ? Math.max(...deps.map(d => levels.get(d))) : -1;
    levels.set(repo, maxDepLevel + 1);
  }
  return levels;
}

function formatPlan(steps, plans) {
  console.log('');
  console.log('  Release Plan');
  console.log('  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('');

  let stepNum = 0;
  let prevLevel = -1;

  for (const step of steps) {
    stepNum++;
    const repoShort = step.repo.split('/').pop();
    const typeLabel = step.type + (step.hasMigrations ? ', has migrations' : '');

    const parallelNote = step.level === prevLevel
      ? `    (parallel with step ${stepNum - 1})`
      : '';

    console.log(`  Step ${stepNum} \u2014 ${repoShort} (${typeLabel})`);
    console.log(`    ${step.script || '(no release script found)'}`);

    if (step.issues.length > 0) {
      console.log(`    Issues: ${step.issues.map(i => '#' + i).join(', ')}`);
    }

    if (step.dependsOn.length > 0) {
      console.log(`    depends on: ${step.dependsOn.map(d => d.split('/').pop()).join(', ')}`);
    }

    if (parallelNote) {
      console.log(parallelNote);
    }

    console.log('');
    prevLevel = step.level;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executePlan(steps, { apiKey, releaseRunId } = {}) {
  const workdir = join(tmpdir(), 'warp-coder', 'release');

  // Clean and create workdir
  if (existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true });
  }
  mkdirSync(workdir, { recursive: true });

  console.log(`  Workdir: ${workdir}`);

  // Clone all unique repos into workdir as siblings
  const clonedRepos = new Map(); // repo full name → local dir

  for (const step of steps) {
    if (clonedRepos.has(step.repo)) continue;
    const repoShort = step.repo.split('/').pop();
    const dest = join(workdir, repoShort);
    const repoUrl = `git@github.com:${step.repo}.git`;

    console.log(`  Cloning ${step.repo}...`);
    try {
      git.cloneRepo(repoUrl, dest);
      clonedRepos.set(step.repo, dest);
    } catch (err) {
      console.error(`  Failed to clone ${step.repo}: ${err.message}`);
      return false;
    }
  }
  console.log('');

  // Group steps by level for parallel execution
  const byLevel = new Map();
  for (const step of steps) {
    if (!byLevel.has(step.level)) byLevel.set(step.level, []);
    byLevel.get(step.level).push(step);
  }

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  let success = true;

  for (const level of sortedLevels) {
    const levelSteps = byLevel.get(level);
    const results = await Promise.all(
      levelSteps.map(step => executeStep(step, {
        repoDir: clonedRepos.get(step.repo),
        apiKey,
        releaseRunId,
      }))
    );

    if (results.some(r => !r)) {
      success = false;
      break;
    }
  }

  // Cleanup
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {}

  return success;
}

async function executeStep(step, { repoDir, apiKey, releaseRunId }) {
  const repoShort = step.repo.split('/').pop();

  if (!step.script) {
    console.log(`  [${repoShort}] No release script — skipping`);
    return true;
  }

  if (!repoDir) {
    console.error(`  [${repoShort}] Repo not cloned`);
    return false;
  }

  // Create a group for this step in WarpMetrics
  let groupId = null;
  if (apiKey && releaseRunId) {
    try {
      const group = await warp.createGroup(apiKey, {
        runId: releaseRunId,
        label: `Release: ${repoShort}`,
        opts: { repo: step.repo, type: step.type, script: step.script, has_migrations: String(step.hasMigrations) },
      });
      groupId = group.groupId;
    } catch {}
  }

  console.log(`  [${repoShort}] Running: ${step.script}`);
  const startTime = Date.now();

  try {
    execSync(step.script, {
      cwd: repoDir,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000, // 10 minute timeout
    });

    const durationMs = Date.now() - startTime;
    console.log(`  [${repoShort}] Done (${Math.round(durationMs / 1000)}s)`);

    // Record success outcome on group
    if (apiKey && groupId) {
      try {
        await warp.recordOutcome(apiKey, { runId: null, groupId }, {
          step: 'release',
          success: true,
          name: 'Released',
        });
      } catch {}
    }

    return true;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`  [${repoShort}] Failed after ${Math.round(durationMs / 1000)}s: ${err.message}`);

    // Record failure outcome on group
    if (apiKey && groupId) {
      try {
        await warp.recordOutcome(apiKey, { runId: null, groupId }, {
          step: 'release',
          success: false,
          error: err.message,
          name: 'Release Failed',
        });
      } catch {}
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

function buildReleaseNotes(plans, steps) {
  const lines = [];
  lines.push('  Release Notes');
  lines.push('  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  lines.push('');

  // Issues
  for (const plan of plans) {
    const issue = plan.issue;
    const num = issue.opts?.issue;
    const name = issue.opts?.name || '';
    lines.push(`  #${num} \u2014 ${name}`);
  }
  lines.push('');

  // Per-repo details from merged PRs
  const allPrs = new Map(); // "repo#number" → { repo, prNumber }
  for (const plan of plans) {
    const prList = plan.issue.shippedOutcome?.opts?.prs;
    if (!prList) continue;
    for (const entry of prList.split(',')) {
      const [repo, num] = entry.trim().split('#');
      if (repo && num) {
        allPrs.set(entry.trim(), { repo, prNumber: parseInt(num, 10) });
      }
    }
  }

  for (const step of steps) {
    const repoShort = step.repo.split('/').pop();
    const typeLabel = step.type + (step.hasMigrations ? ', migrations' : '');
    lines.push(`  ${repoShort} (${typeLabel})`);

    // Find PRs for this repo
    const repoPrs = [...allPrs.values()].filter(p => p.repo === step.repo);
    for (const { repo, prNumber } of repoPrs) {
      try {
        const commits = git.getPRCommits(prNumber, { repo });
        const files = git.getPRFiles(prNumber, { repo });
        const additions = files.reduce((s, f) => s + (f.additions || 0), 0);
        const deletions = files.reduce((s, f) => s + (f.deletions || 0), 0);

        lines.push(`    PR #${prNumber}`);
        for (const c of commits) {
          const headline = c.messageHeadline || c.message?.split('\n')[0] || '';
          lines.push(`      \u2022 ${headline}`);
        }
        lines.push(`      ${files.length} file${files.length !== 1 ? 's' : ''} (+${additions} \u2212${deletions})`);
      } catch {
        lines.push(`    PR #${prNumber} (could not fetch details)`);
      }
    }

    if (repoPrs.length === 0) {
      lines.push(`    (no PRs)`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Preview: generate changelog entries without releasing
// ---------------------------------------------------------------------------

async function publishChangelog(config, plans, steps) {
  const provider = createChangelogProvider(config);
  if (!provider) {
    console.log('');
    console.log('  No changelog provider configured — skipping changelog.');
    return;
  }

  // Gather PR context from all plans
  const allContext = [];
  for (const plan of plans) {
    const prList = plan.issue.shippedOutcome?.opts?.prs;
    if (!prList) continue;

    const prs = prList.split(',').map(s => {
      const [repo, num] = s.trim().split('#');
      return { repo, prNumber: parseInt(num, 10) };
    }).filter(p => p.repo && p.prNumber);

    for (const { repo, prNumber } of prs) {
      try {
        const files = git.getPRFiles(prNumber, { repo });
        const commits = git.getPRCommits(prNumber, { repo });
        allContext.push({ repo, prNumber, files, commits });
      } catch {}
    }
  }

  if (allContext.length === 0) return;

  const issueTitles = plans
    .map(p => {
      const num = p.issue.opts?.issue;
      const title = p.issue.opts?.title || '';
      return num ? `#${num}: ${title}` : null;
    })
    .filter(Boolean);

  const technicalContext = allContext.map(({ repo, prNumber, files, commits }) => {
    const commitLines = commits.map(c => {
      const headline = c.messageHeadline || c.message?.split('\n')[0] || '';
      return `- ${headline}`;
    }).join('\n');
    const fileLines = files.map(f => `  ${f.path} (+${f.additions || 0} -${f.deletions || 0})`).join('\n');
    return `Repo: ${repo}, PR #${prNumber}\nCommits:\n${commitLines}\nFiles:\n${fileLines}`;
  }).join('\n\n');

  const context = `Issues:\n${issueTitles.join('\n')}\n\n---\n\nChanges:\n${technicalContext}`;

  console.log('');
  console.log('  Generating changelog entries...');

  const publicEntry = generateChangelogEntry(execFileSync, `${PUBLIC_PROMPT}\n\n---\n\n${context}`);
  const privateEntry = generateChangelogEntry(execFileSync, `${PRIVATE_PROMPT}\n\n---\n\n${context}`);

  if (!publicEntry && !privateEntry) {
    console.log('  Changelog generation failed — skipping.');
    return;
  }

  console.log('');
  if (publicEntry) {
    console.log('  Public Entry');
    console.log('  ────────────');
    console.log(`  Title: ${publicEntry.title}`);
    console.log(`  Summary: ${publicEntry.summary}`);
    console.log('');
  }
  if (privateEntry) {
    console.log('  Private Entry');
    console.log('  ─────────────');
    console.log(`  Title: ${privateEntry.title}`);
    console.log(`  Summary: ${privateEntry.summary}`);
    console.log('');
  }

  const shouldPush = await confirm('  Publish changelog entries? [y/N] ');
  if (!shouldPush) {
    console.log('  Changelog skipped.');
    return;
  }

  if (publicEntry) {
    try {
      await provider.post({ title: publicEntry.title, summary: publicEntry.summary, content: publicEntry.content, visibility: 'public', tags: publicEntry.tags });
      console.log('  ✓ Public entry published');
    } catch (err) {
      console.log(`  ✗ Public entry failed: ${err.message}`);
    }
  }
  if (privateEntry) {
    try {
      await provider.post({ title: privateEntry.title, summary: privateEntry.summary, content: privateEntry.content, visibility: 'private', tags: privateEntry.tags });
      console.log('  ✓ Private entry published');
    } catch (err) {
      console.log(`  ✗ Private entry failed: ${err.message}`);
    }
  }
}

export async function releasePreview() {
  const config = loadConfig();
  const apiKey = config.warpmetricsApiKey;

  if (!apiKey) {
    console.error('Error: warpmetricsApiKey not set in config.');
    process.exit(1);
  }

  console.log('');
  console.log('  Fetching shipped issues from WarpMetrics...');

  const shipped = await warp.findShippedIssues(apiKey);

  if (shipped.length === 0) {
    console.log('  No shipped issues found.');
    console.log('');
    return;
  }

  console.log(`  Found ${shipped.length} shipped issue(s)`);
  console.log('');

  // Gather context from each shipped issue's PRs
  const allContext = [];
  for (const issue of shipped) {
    const prList = issue.shippedOutcome?.opts?.prs;
    if (!prList) continue;

    const prs = prList.split(',').map(s => {
      const [repo, num] = s.trim().split('#');
      return { repo, prNumber: parseInt(num, 10) };
    }).filter(p => p.repo && p.prNumber);

    for (const { repo, prNumber } of prs) {
      try {
        const files = git.getPRFiles(prNumber, { repo });
        const commits = git.getPRCommits(prNumber, { repo });
        allContext.push({ repo, prNumber, files, commits });
      } catch (err) {
        console.log(`  Warning: could not fetch PR ${repo}#${prNumber}: ${err.message}`);
      }
    }
  }

  if (allContext.length === 0) {
    console.log('  No PR details found.');
    console.log('');
    return;
  }

  // Build issue titles from shipped issues
  const issueTitles = shipped
    .map(s => {
      const num = s.opts?.issue;
      const title = s.opts?.title || '';
      return num ? `#${num}: ${title}` : null;
    })
    .filter(Boolean);

  // Build technical context
  const technicalContext = allContext.map(({ repo, prNumber, files, commits }) => {
    const commitLines = commits.map(c => {
      const headline = c.messageHeadline || c.message?.split('\n')[0] || '';
      return `- ${headline}`;
    }).join('\n');
    const fileLines = files.map(f => `  ${f.path} (+${f.additions || 0} -${f.deletions || 0})`).join('\n');
    return `Repo: ${repo}, PR #${prNumber}\nCommits:\n${commitLines}\nFiles:\n${fileLines}`;
  }).join('\n\n');

  const context = `Issues:\n${issueTitles.join('\n')}\n\n---\n\nChanges:\n${technicalContext}`;

  // Generate entries
  console.log('  Generating changelog entries...');
  console.log('');

  const publicEntry = generateChangelogEntry(execFileSync, `${PUBLIC_PROMPT}\n\n---\n\n${context}`);
  const privateEntry = generateChangelogEntry(execFileSync, `${PRIVATE_PROMPT}\n\n---\n\n${context}`);

  if (publicEntry) {
    console.log('  Public Entry');
    console.log('  ────────────');
    console.log(`  Title: ${publicEntry.title}`);
    console.log(`  Tags:  ${(publicEntry.tags || []).join(', ')}`);
    console.log(`  Summary: ${publicEntry.summary}`);
    console.log('');
    console.log(publicEntry.content.split('\n').map(l => '  ' + l).join('\n'));
    console.log('');
  } else {
    console.log('  (public entry generation failed)');
    console.log('');
  }

  if (privateEntry) {
    console.log('  Private Entry');
    console.log('  ─────────────');
    console.log(`  Title: ${privateEntry.title}`);
    console.log(`  Tags:  ${(privateEntry.tags || []).join(', ')}`);
    console.log(`  Summary: ${privateEntry.summary}`);
    console.log('');
    console.log(privateEntry.content.split('\n').map(l => '  ' + l).join('\n'));
    console.log('');
  } else {
    console.log('  (private entry generation failed)');
    console.log('');
  }

  // Offer to push
  const provider = createChangelogProvider(config);

  if (provider) {
    const shouldPush = await confirm('  Push changelog entries? [y/N] ');
    if (shouldPush) {
      if (publicEntry) {
        try {
          await provider.post({ title: publicEntry.title, summary: publicEntry.summary, content: publicEntry.content, visibility: 'public', tags: publicEntry.tags });
          console.log('  ✓ Public entry pushed');
        } catch (err) {
          console.log(`  ✗ Public entry failed: ${err.message}`);
        }
      }
      if (privateEntry) {
        try {
          await provider.post({ title: privateEntry.title, summary: privateEntry.summary, content: privateEntry.content, visibility: 'private', tags: privateEntry.tags });
          console.log('  ✓ Private entry pushed');
        } catch (err) {
          console.log(`  ✗ Private entry failed: ${err.message}`);
        }
      }
    } else {
      console.log('  Skipped.');
    }
  } else {
    console.log('  No changelog provider configured — entries not pushed.');
    console.log('  Add "changelog" to config.json to enable pushing.');
  }

  console.log('');
}

function confirm(prompt) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
