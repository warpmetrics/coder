// Release executor: generates changelog entries after deploy.
// Extracted from watch.js inline executor.

import { generateChangelogEntry, createChangelogProvider } from './changelog.js';
import { PUBLIC_CHANGELOG as PUBLIC_PROMPT, PRIVATE_CHANGELOG as PRIVATE_PROMPT } from './prompt.js';
import { OUTCOMES } from '../../names.js';

export const definition = {
  name: 'release',
  resultTypes: ['success', 'error'],
  effects: {
    async success(run, result, ctx) {
      const { config, clients: { warp, board, log } } = ctx;
      const apiKey = config.warpmetricsApiKey;
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
          const groups = issue.groups || {};
          const releaseGroup = groups['Release'];
          if (releaseGroup) {
            await warp.recordIssueOutcome(apiKey, { runId: releaseGroup, name: OUTCOMES.RELEASING });
            await warp.recordIssueOutcome(apiKey, { runId: releaseGroup, name: OUTCOMES.RELEASED });
          }
          await warp.recordIssueOutcome(apiKey, { runId: issue.runId, name: OUTCOMES.RELEASED });
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
  },
  create() {
    return release;
  },
};

export async function release(run, ctx) {
  const { config, clients: { prs, claudeCode, log }, context: { actOpts } } = ctx;
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
      const files = prs.getPRFiles(prNumber, { repo });
      const commits = prs.getPRCommits(prNumber, { repo });
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

  log('generating changelog entries...');
  const publicResult = await generateChangelogEntry(claudeCode, `${PUBLIC_PROMPT}\n\n---\n\n${context}`);
  const privateResult = await generateChangelogEntry(claudeCode, `${PRIVATE_PROMPT}\n\n---\n\n${context}`);

  const totalCost = (publicResult?.costUsd || 0) + (privateResult?.costUsd || 0);

  if (!publicResult && !privateResult) {
    log('changelog generation failed');
    return { type: 'success', costUsd: null, trace: null, outcomeOpts: {}, batchedIssues };
  }

  // Publish as a single combined entry
  const provider = createChangelogProvider(config);
  if (!provider) {
    log('no changelog provider configured, skipping publish');
    return { type: 'success', costUsd: null, trace: null, outcomeOpts: {}, batchedIssues };
  }

  try {
    const title = publicResult?.title || privateResult?.title;
    const tags = publicResult?.tags || privateResult?.tags;
    await provider.post({
      title,
      publicEntry: publicResult?.entry || null,
      privateEntry: privateResult?.entry || null,
      publicEntryVisible: Boolean(publicResult?.entry),
      tags,
    });
    log('changelog entry published');
  } catch (err) {
    log(`changelog entry failed: ${err.message}`);
  }

  return { type: 'success', costUsd: totalCost || null, trace: null, outcomeOpts: {}, batchedIssues };
}
