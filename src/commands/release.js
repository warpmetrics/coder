// Release command: analyzes shipped issues, builds a dependency-ordered
// release plan, and executes it (packages before services, migrations first).

import { execFileSync, execSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../config.js';
import * as warp from '../clients/warp.js';
import { createGitClient } from '../clients/git.js';
import { createPRClient } from '../clients/prs/index.js';
import { topoSort, mergeDAGs, buildSteps } from '../executors/deploy/plan.js';
import { rawRun } from '../clients/claude-code.js';
import { createChangelogProvider, generateChangelogEntry } from '../executors/release/changelog.js';
import { PUBLIC_CHANGELOG as PUBLIC_PROMPT, PRIVATE_CHANGELOG as PRIVATE_PROMPT } from '../executors/release/prompt.js';
import { OUTCOMES } from '../names.js';

const prs = createPRClient();

function parsePRList(prList) {
  if (!prList) return [];
  return prList.split(',').map(s => {
    const [repo, num] = s.trim().split('#');
    return { repo, prNumber: parseInt(num, 10) };
  }).filter(p => p.repo && p.prNumber);
}

// ---------------------------------------------------------------------------
// Release command (CLI entry point)
// ---------------------------------------------------------------------------

export async function release() {
  const config = loadConfig();
  const git = createGitClient({ token: config.githubToken });
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
      console.log(`  Skipping issue ${issue.opts?.issue ? '#' + issue.opts.issue : issue.runId}: no release metadata`);
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
      await warp.recordOutcome(apiKey, { runId: releaseRunId, groupId: null }, {
        step: 'release', success,
      });
    } catch {}
  }

  // Record outcome on each Issue run
  const issueName = success ? OUTCOMES.RELEASED : OUTCOMES.RELEASE_FAILED;
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
    await publishChangelog(config, plans);
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
  if (!opts?.release && !opts?.releaseSteps) return null;

  if (opts.release) return { release: opts.release };

  // Legacy: releaseSteps + releaseDAG → convert
  const dag = opts.releaseDAG || {};
  return {
    release: opts.releaseSteps.map(s => ({
      repo: s.repo, command: s.script, dependsOn: dag[s.repo] || [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Step building and display
// ---------------------------------------------------------------------------


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
    const parallelNote = step.level === prevLevel
      ? `    (parallel with step ${stepNum - 1})`
      : '';

    console.log(`  Step ${stepNum} \u2014 ${repoShort}`);
    console.log(`    ${step.command || '(no release command found)'}`);

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
      git.clone(repoUrl, dest);
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

  if (!step.command) {
    console.log(`  [${repoShort}] No release command — skipping`);
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
        opts: { repo: step.repo, command: step.command },
      });
      groupId = group.groupId;
    } catch {}
  }

  console.log(`  [${repoShort}] Running: ${step.command}`);
  const startTime = Date.now();

  try {
    execSync(step.command, {
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
          name: OUTCOMES.RELEASED,
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
          name: OUTCOMES.RELEASE_FAILED,
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
  const allPrs = new Map();
  for (const plan of plans) {
    for (const pr of parsePRList(plan.issue.shippedOutcome?.opts?.prs)) {
      allPrs.set(`${pr.repo}#${pr.prNumber}`, pr);
    }
  }

  for (const step of steps) {
    const repoShort = step.repo.split('/').pop();
    lines.push(`  ${repoShort}`);

    // Find PRs for this repo
    const repoPrs = [...allPrs.values()].filter(p => p.repo === step.repo);
    for (const { repo, prNumber } of repoPrs) {
      try {
        const commits = prs.getPRCommits(prNumber, { repo });
        const files = prs.getPRFiles(prNumber, { repo });
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
// Changelog generation
// ---------------------------------------------------------------------------

function gatherPRContext(issues, { verbose = false } = {}) {
  const context = [];
  for (const { prList } of issues) {
    for (const { repo, prNumber } of parsePRList(prList)) {
      try {
        const files = prs.getPRFiles(prNumber, { repo });
        const commits = prs.getPRCommits(prNumber, { repo });
        context.push({ repo, prNumber, files, commits });
      } catch (err) {
        if (verbose) console.log(`  Warning: could not fetch PR ${repo}#${prNumber}: ${err.message}`);
      }
    }
  }
  return context;
}

function buildChangelogPrompt(issueTitles, prContext) {
  const technicalContext = prContext.map(({ repo, prNumber, files, commits }) => {
    const commitLines = commits.map(c => `- ${c.messageHeadline || c.message?.split('\n')[0] || ''}`).join('\n');
    const fileLines = files.map(f => `  ${f.path} (+${f.additions || 0} -${f.deletions || 0})`).join('\n');
    return `Repo: ${repo}, PR #${prNumber}\nCommits:\n${commitLines}\nFiles:\n${fileLines}`;
  }).join('\n\n');
  return `Issues:\n${issueTitles.join('\n')}\n\n---\n\nChanges:\n${technicalContext}`;
}

async function generateChangelog(config, { issues, verbose = false }) {
  const prContext = gatherPRContext(issues, { verbose });
  if (prContext.length === 0) {
    if (verbose) { console.log('  No PR details found.'); console.log(''); }
    return;
  }

  const issueTitles = issues.map(i => i.title).filter(Boolean);
  const context = buildChangelogPrompt(issueTitles, prContext);

  console.log('');
  console.log('  Generating changelog entries...');
  if (verbose) console.log('');

  const claudeCode = { run: (opts) => rawRun(opts) };
  const publicEntry = generateChangelogEntry(claudeCode, `${PUBLIC_PROMPT}\n\n---\n\n${context}`);
  const privateEntry = generateChangelogEntry(claudeCode, `${PRIVATE_PROMPT}\n\n---\n\n${context}`);

  if (!publicEntry && !privateEntry) {
    console.log('  Changelog generation failed.');
    return;
  }

  console.log('');
  for (const [label, entry] of [['Public', publicEntry], ['Private', privateEntry]]) {
    if (!entry) {
      if (verbose) console.log(`  (${label.toLowerCase()} entry generation failed)\n`);
      continue;
    }
    console.log(`  ${label} Entry`);
    console.log(`  ${'─'.repeat(label.length + 6)}`);
    console.log(`  Title: ${entry.title}`);
    if (verbose && entry.tags?.length) console.log(`  Tags:  ${entry.tags.join(', ')}`);
    console.log(`  Summary: ${entry.summary}`);
    if (verbose && entry.content) {
      console.log('');
      console.log(entry.content.split('\n').map(l => '  ' + l).join('\n'));
    }
    console.log('');
  }

  const provider = createChangelogProvider(config);
  if (!provider) {
    console.log('  No changelog provider configured — skipping.');
    if (verbose) console.log('  Add "changelog" to config.json to enable pushing.');
    return;
  }

  const shouldPush = await confirm('  Publish changelog entries? [y/N] ');
  if (!shouldPush) { console.log('  Skipped.'); return; }

  for (const [label, entry, visibility] of [['Public', publicEntry, 'public'], ['Private', privateEntry, 'private']]) {
    if (!entry) continue;
    try {
      await provider.post({ title: entry.title, summary: entry.summary, content: entry.content, visibility, tags: entry.tags });
      console.log(`  ✓ ${label} entry published`);
    } catch (err) {
      console.log(`  ✗ ${label} entry failed: ${err.message}`);
    }
  }
}

async function publishChangelog(config, plans) {
  const issues = plans.map(p => ({
    title: p.issue.opts?.issue ? `#${p.issue.opts.issue}: ${p.issue.opts.title || ''}` : null,
    prList: p.issue.shippedOutcome?.opts?.prs,
  })).filter(i => i.title);
  await generateChangelog(config, { issues });
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

  const issues = shipped.map(s => ({
    title: s.opts?.issue ? `#${s.opts.issue}: ${s.opts.title || ''}` : null,
    prList: s.shippedOutcome?.opts?.prs,
  })).filter(i => i.title);

  await generateChangelog(config, { issues, verbose: true });
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
