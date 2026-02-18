// Implement a single task: clone → branch → claude → push → PR

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { repoName, deriveRepoDirNames, CONFIG_DIR } from './config.js';
import * as git from './git.js';
import * as claude from './claude.js';
import * as warp from './warp.js';
import { warp as warpInit, trace, flush } from '@warpmetrics/warp';
import { safeHook } from './hooks.js';
import { loadMemory } from './memory.js';
import { reflect } from './reflect.js';

async function classifyIntent(message) {
  try {
    const { execFileSync } = await import('child_process');
    const result = execFileSync('claude', [
      '-p',
      `Classify this message's intent. Reply with exactly one word: PROPOSE or IMPLEMENT.\n\nPROPOSE = the user explicitly asks for analysis, review, proposal, or discussion BEFORE making changes. They want to talk first.\nIMPLEMENT = anything else: direct feature requests, bug fixes, confirmations, approvals, or instructions to build/change/add something.\n\nWhen in doubt, choose IMPLEMENT.\n\nMessage:\n${message}`,
      '--max-turns', '1',
      '--model', 'haiku',
      '--no-session-persistence',
    ], { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return result.toUpperCase().includes('PROPOSE');
  } catch {
    return false; // default to implement on failure
  }
}

export async function implement(item, { board, config, log, refActId, resumeSession, onStep, onBeforeLog }) {
  const issueId = item._issueId;
  const issueTitle = item.content?.title || `Issue #${issueId}`;
  const issueBody = item.content?.body || '';
  const repos = config.repos;
  const primaryRepoName = repoName(repos[0]);
  const branch = typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`;
  const workdir = join(tmpdir(), 'warp-coder', String(issueId));
  const configDir = join(process.cwd(), CONFIG_DIR);
  const resuming = resumeSession && existsSync(workdir);

  log(`Implementing #${issueId}: ${issueTitle}${resuming ? ' (resuming session)' : ''}`);

  // Initialize warp SDK for trace() calls
  if (config.warpmetricsApiKey) {
    warpInit(null, { apiKey: config.warpmetricsApiKey });
  }

  // Move to In Progress
  try {
    await board.moveToInProgress(item);
    log('  moved to In Progress');
  } catch (err) {
    log(`  warning: could not move to In Progress: ${err.message}`);
  }

  // Pre-generate act ID for chaining (embedded in PRIMARY PR body so warp-review can link back)
  const actId = config.warpmetricsApiKey ? warp.generateId('act') : null;

  // WarpMetrics: start pipeline
  let runId = null;
  let groupId = null;
  if (config.warpmetricsApiKey) {
    try {
      const pipeline = await warp.startPipeline(config.warpmetricsApiKey, {
        step: resuming ? 'implement-resume' : 'implement',
        repo: primaryRepoName,
        issueNumber: issueId,
        issueTitle,
        refActId,
      });
      runId = pipeline.runId;
      groupId = pipeline.groupId;
      log(`  pipeline: run=${runId} group=${groupId}`);
    } catch (err) {
      log(`  warning: pipeline start failed: ${err.message}`);
    }
  }

  let success = false;
  let claudeResult = null;
  let taskError = null;
  let hitMaxTurns = false;
  let askUserQuestion = null;
  const hookOutputs = [];

  const dirNames = deriveRepoDirNames(repos);
  const repoDirs = []; // { url, name, dirName, dir }
  const primaryUrl = repos[0];
  const primaryDirName = dirNames[0];
  const primaryDest = join(workdir, primaryDirName);

  try {
    if (resuming) {
      // Resuming a previous session — workdir and repos already exist
      log(`  resuming in ${workdir}`);
      repoDirs.push({ url: primaryUrl, name: primaryRepoName, dirName: primaryDirName, dir: primaryDest });

      // Re-discover any additional repos that were cloned previously
      for (let i = 1; i < repos.length; i++) {
        const dirName = dirNames[i];
        const candidateDir = join(workdir, dirName);
        if (existsSync(join(candidateDir, '.git'))) {
          repoDirs.push({ url: repos[i], name: repoName(repos[i]), dirName, dir: candidateDir });
        }
      }
    } else {
      // Fresh start — clone repos
      onStep?.('cloning');
      rmSync(workdir, { recursive: true, force: true });
      mkdirSync(workdir, { recursive: true });

      log(`  cloning ${primaryRepoName} into ${primaryDest}`);
      git.cloneRepo(primaryUrl, primaryDest);
      git.createBranch(primaryDest, branch);
      repoDirs.push({ url: primaryUrl, name: primaryRepoName, dirName: primaryDirName, dir: primaryDest });

      log(`  branch: ${branch}`);
    }

    // Hook: onBranchCreate (called once with primary repo context, skip on resume)
    if (!resuming) {
      safeHook('onBranchCreate', config, { workdir, issueNumber: issueId, branch, repo: primaryRepoName }, hookOutputs);
    }

    // Fetch issue comments for context (clarification Q&A, user notes, etc.)
    // The "last human message" determines intent: propose vs implement.
    // On first run (no comments) it's the issue body. After that, it's the last non-bot comment.
    let commentsText = '';
    let lastHumanMessage = issueBody;
    try {
      const comments = git.getIssueComments(issueId, { repo: primaryRepoName });
      if (comments.length > 0) {
        // Find the last comment NOT from warp-coder
        const lastHuman = [...comments].reverse().find(c =>
          !(c.body || '').includes('warp-coder')
        );
        if (lastHuman) {
          lastHumanMessage = (lastHuman.body || '').replace(/<!--[\s\S]*?-->\n*/g, '').trim();
        }

        commentsText = comments.map(c => {
          const author = c.user?.login || 'unknown';
          const body = (c.body || '').replace(/<!--[\s\S]*?-->\n*/g, '').trim();
          return body ? `**${author}:** ${body}` : null;
        }).filter(Boolean).join('\n\n');
      }
    } catch {
      // Comments unavailable (e.g. Linear board) — not critical
    }

    // Load memory for prompt enrichment
    const memory = config.memory?.enabled !== false ? loadMemory(configDir) : '';

    // Build Claude prompt
    const promptParts = [];

    promptParts.push(
      '## Workspace layout',
      '',
      `Root directory: ${workdir}`,
      'Repos are cloned as subdirectories of the root:',
      '',
      `  ${workdir}/                  ← root (NOT a git repo)`,
      `    ${primaryDirName}/   ← ${primaryRepoName} (already cloned)`,
      ...repos.slice(1).map((_, i) => `    ${dirNames[i + 1]}/   ← ${repoName(repos[i + 1])} (clone if needed)`),
      '',
      'Decide which repo(s) to work in based on the task.',
      '',
      `Special files like \`.warp-coder-ask\` MUST be written to the root: ${workdir}/.warp-coder-ask`,
      '',
    );

    if (repos.length > 1) {
      const otherRepoLines = [];
      for (let i = 1; i < repos.length; i++) {
        const name = repoName(repos[i]);
        const dirName = dirNames[i];
        otherRepoLines.push(`  # ${name} — clone into the root, NOT inside another repo`);
        otherRepoLines.push(`  cd ${workdir} && git clone ${repos[i]} ${dirName} && cd ${dirName} && git checkout -b ${branch}`);
      }
      promptParts.push(
        `If any part of the issue could involve another repo — even just to understand how something works — clone it and investigate before deciding on an approach. Do not guess at behavior you can verify by reading the code.`,
        '',
        ...otherRepoLines,
        '',
        `IMPORTANT: These repos are SEPARATE git repositories cloned as siblings under ${workdir}/. Never clone one repo inside another.`,
        '',
      );
    }

    if (memory) {
      promptParts.push(
        'Lessons learned from previous tasks in this repository:',
        '',
        memory,
        '',
      );
    }

    if (commentsText) {
      promptParts.push(
        'Discussion on the issue:',
        '',
        commentsText,
        '',
      );
    }

    promptParts.push(
      `## Task`,
      '',
      `You are working on issue #${issueId}: "${issueTitle}" and ONLY this issue.`,
      'All issue context (body, comments, user feedback) is provided above — do NOT use `gh` to fetch issues, PRs, or comments.',
      'Ignore branches, PRs, or code changes related to other issues you may find in the repo.',
      '',
      issueBody,
      '',
    );

    // Classify the last human message to determine intent: propose or implement.
    const shouldPropose = await classifyIntent(lastHumanMessage);

    if (shouldPropose) {
      promptParts.push(
        'The user is asking you to analyze or propose rather than directly implement.',
        'DO NOT make code changes. Instead, write your analysis as markdown to:',
        `${workdir}/.warp-coder-ask`,
        'Then stop. The user will reply on the issue and you will be re-run with their response.',
        '',
      );
    } else {
      promptParts.push(
        'Proceed with these steps:',
        '',
        ...(repos.length > 1
          ? [
              '1. Clone any other repos that could be relevant (see commands above)',
              '2. Read the codebase to understand relevant context',
            ]
          : [
              '1. Read the codebase to understand relevant context',
            ]
        ),
        `${repos.length > 1 ? '3' : '2'}. Implement the changes`,
        `${repos.length > 1 ? '4' : '3'}. Run tests to verify nothing is broken`,
        `${repos.length > 1 ? '5' : '4'}. Commit all changes with a clear message — this is critical, do not skip the commit`,
        '',
        'Important: commit separately in each repo that has changes. Do NOT push or open PRs.',
        '',
      );
    }

    promptParts.push(
      '## Efficiency',
      '',
      'You have a limited turn budget. Use subagents (the Task tool) aggressively:',
      '- Research multiple repos or files in parallel instead of sequentially',
      '- Delegate codebase exploration to subagents while you plan',
      '- Run tests in background subagents while you continue working',
      '- Use subagents for any read-heavy task (finding usages, understanding patterns)',
      'Each subagent call counts as one turn regardless of how much work it does internally.',
    );

    const prompt = resuming
      ? 'You were interrupted because you hit the turn limit. Your previous work is intact in the working directory. Continue where you left off — finish implementing, run tests, and commit.'
      : promptParts.join('\n');

    // Claude runs in the parent workdir (repos are in subdirectories)
    onStep?.('claude');
    log(`  running claude${resuming ? ` (resuming session ${resumeSession})` : ''}...`);
    const claudeStart = Date.now();
    claudeResult = await claude.run({
      prompt,
      workdir,
      resume: resuming ? resumeSession : undefined,
      allowedTools: config.claude?.allowedTools,
      disallowedTools: config.claude?.disallowedTools || ['Bash(gh *)'],
      maxTurns: config.claude?.maxTurns,
      logPrefix: `[#${issueId}] `,
      onBeforeLog,
    });
    const claudeDuration = Date.now() - claudeStart;
    log(`  claude done (cost: $${claudeResult.costUsd ?? '?'})`);

    // Trace the Claude Code call in WarpMetrics
    if (groupId) {
      try {
        trace(groupId, {
          provider: 'anthropic',
          model: 'claude-code',
          duration: claudeDuration,
          startedAt: new Date(claudeStart).toISOString(),
          endedAt: new Date(claudeStart + claudeDuration).toISOString(),
          cost: claudeResult.costUsd,
          status: claudeResult.subtype === 'error_max_turns' ? 'error' : 'success',
          opts: {
            turns: claudeResult.numTurns,
            session_id: claudeResult.sessionId,
          },
        });
        await flush();
      } catch {}
    }

    // Check if Claude hit max turns
    if (claudeResult.subtype === 'error_max_turns') {
      hitMaxTurns = true;
      throw new Error(`Claude reached the maximum number of turns (${claudeResult.numTurns || config.claude?.maxTurns || '?'}) without completing the task`);
    }

    // Check if Claude is asking for clarification (root first, then repo dirs as fallback)
    // Only check when we told Claude to propose — otherwise ignore the file.
    if (shouldPropose) {
      const askCandidates = [
        join(workdir, '.warp-coder-ask'),
        ...repoDirs.map(r => join(r.dir, '.warp-coder-ask')),
      ];
      for (const askFile of askCandidates) {
        if (existsSync(askFile)) {
          askUserQuestion = readFileSync(askFile, 'utf-8').trim() || null;
          if (askUserQuestion) break;
        }
      }
    }

    if (askUserQuestion) {
      log(`  clarification needed`);
    } else {
      // Discover repos Claude may have cloned
      for (let i = 1; i < repos.length; i++) {
        const dirName = dirNames[i];
        const candidateDir = join(workdir, dirName);
        if (existsSync(join(candidateDir, '.git'))) {
          const name = repoName(repos[i]);
          log(`  discovered cloned repo: ${dirName}/`);
          repoDirs.push({ url: repos[i], name, dirName, dir: candidateDir });
        }
      }

      // Log per-repo status after Claude
      for (const { dir, dirName } of repoDirs) {
        log(`  ${dirName}: git status: ${git.status(dir) || '(clean)'}`);
        log(`  ${dirName}: git log: ${git.hasNewCommits(dir) ? 'has new commits' : 'NO new commits'}`);
      }

      // Hook: onBeforePush
      onStep?.('pushing');
      safeHook('onBeforePush', config, { workdir, issueNumber: issueId, branch, repo: primaryRepoName }, hookOutputs);

      // Check each repo for changes, auto-commit, push, and create PR
      let anyChanges = false;
      let primaryPRCreated = false;
      const createdPRs = [];

      for (const { dir, name, dirName } of repoDirs) {
        // Exclude sibling repo directories and temp files so git add -A doesn't pick them up
        const excludeEntries = [
          ...repoDirs.filter(r => r.dir !== dir).map(r => r.dirName),
          '.warp-coder-ask',
        ];
        const excludeFile = join(dir, '.git', 'info', 'exclude');
        const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
        const additions = excludeEntries.filter(e => !existing.includes(e));
        if (additions.length > 0) {
          writeFileSync(excludeFile, existing.trimEnd() + '\n' + additions.join('\n') + '\n');
        }

        const repoStatus = git.status(dir);

        // Auto-commit if Claude left uncommitted changes
        if (repoStatus) {
          log(`  ${dirName}: claude left uncommitted changes — auto-committing`);
          git.commitAll(dir, `Implement #${issueId}: ${issueTitle}`);
        }

        // Claude may have cloned a repo but forgotten to create the branch
        const currentBranch = git.getCurrentBranch(dir);
        if (currentBranch !== branch && git.hasNewCommits(dir)) {
          log(`  ${dirName}: commits on ${currentBranch} — creating branch ${branch}`);
          git.createBranch(dir, branch);
        }

        if (!git.hasNewCommits(dir)) {
          log(`  ${dirName}: no changes`);
          continue;
        }

        anyChanges = true;
        log(`  ${dirName}: pushing...`);
        git.push(dir, branch);

        // First PR with changes gets "Closes", others get "Part of"
        // Always use full repo reference unless PR is in the primary repo
        const isFirstPR = !primaryPRCreated;
        const inPrimaryRepo = name === primaryRepoName;
        const issueRef = inPrimaryRepo ? `#${issueId}` : `${primaryRepoName}#${issueId}`;
        const closeVerb = isFirstPR ? 'Closes' : 'Part of';
        const prBody = [
          `${closeVerb} ${issueRef}`,
          '',
          'Implemented by warp-coder.',
          ...(actId ? ['', `<!-- wm:act:${actId} -->`] : []),
        ].join('\n');

        const pr = git.createPR(dir, {
          title: issueTitle,
          body: prBody,
          head: branch,
        });
        log(`  ${dirName}: PR created: ${pr.url}`);
        createdPRs.push({ repo: name, number: pr.number, url: pr.url });
        primaryPRCreated = true;

        // Hook: onPRCreated
        safeHook('onPRCreated', config, { workdir: dir, issueNumber: issueId, prNumber: pr.number, branch, repo: name }, hookOutputs);
      }

      if (!anyChanges) {
        // No changes and no .warp-coder-ask — Claude failed to produce changes.
        // Only treat as clarification if Claude explicitly wrote the ask file.
        throw new Error('No changes were produced');
      }

      // Post PR links on the issue
      try {
        const prLines = createdPRs.map(p => `- ${p.repo}#${p.number}`).join('\n');
        git.botComment(issueId, { repo: primaryRepoName, body: `PRs ready for review:\n\n${prLines}` });
      } catch {}

      // Move to In Review
      try {
        await board.moveToReview(item);
        log('  moved to In Review');
      } catch (err) {
        log(`  warning: could not move to In Review: ${err.message}`);
      }

      success = true;
    }
  } catch (err) {
    taskError = err.message;
    log(`  failed: ${err.message}`);
    if (hitMaxTurns) {
      // Max turns — move back to Todo for automatic retry with resume
      try {
        git.botComment(issueId, { repo: primaryRepoName, body: `Implementation failed: ${err.message}` });
      } catch {}
      try {
        await board.moveToTodo(item);
        log('  moved to Todo (will resume)');
      } catch (moveErr) {
        log(`  warning: could not move to Todo: ${moveErr.message}`);
      }
    } else {
      try {
        git.botComment(issueId, { repo: primaryRepoName, body: `Implementation failed: ${err.message}` });
      } catch {}
      try {
        await board.moveToBlocked(item);
      } catch (moveErr) {
        log(`  warning: could not move to Blocked: ${moveErr.message}`);
      }
    }
  } finally {
    // WarpMetrics: record outcome
    if (config.warpmetricsApiKey && groupId) {
      try {
        const outcome = await warp.recordOutcome(config.warpmetricsApiKey, { runId, groupId }, {
          step: 'implement',
          success,
          costUsd: claudeResult?.costUsd,
          error: taskError,
          hooksFailed: hookOutputs.some(h => h.exitCode !== 0),
          issueNumber: issueId,
          ...(askUserQuestion ? { name: 'Needs Clarification' } : hitMaxTurns ? { name: 'Max Retries' } : {}),
        });
        log(`  outcome: ${outcome.name}`);

        // Emit act so warp-review can link its run as a follow-up
        if (success && actId && outcome.runOutcomeId) {
          await warp.emitAct(config.warpmetricsApiKey, {
            outcomeId: outcome.runOutcomeId,
            actId,
            name: 'Review',
          });
        }
      } catch (err) {
        log(`  warning: outcome recording failed: ${err.message}`);
      }
    }

    // Reflect (skip for clarification requests)
    if (!askUserQuestion && config.memory?.enabled !== false) {
      try {
        await reflect({
          configDir,
          step: 'implement',
          issue: { number: issueId, title: issueTitle },
          success,
          error: taskError,
          hookOutputs: hookOutputs.filter(h => h.ran),
          claudeOutput: claudeResult?.result,
          maxLines: config.memory?.maxLines || 100,
        });
        log('  reflect: memory updated');
      } catch (err) {
        log(`  warning: reflect failed: ${err.message}`);
      }
    }

    // Cleanup — preserve workdir on max-turns so we can resume
    if (!hitMaxTurns) {
      rmSync(workdir, { recursive: true, force: true });
    } else {
      log(`  workdir preserved for resume: ${workdir}`);
    }
  }

  return {
    success,
    askUser: askUserQuestion,
    hitMaxTurns,
    sessionId: claudeResult?.sessionId,
  };
}
