// CodeHost executors: merge.
// Extracted from watch.js processMerge.

import { runHook } from '../agent/hooks.js';

export async function merge(item, { config, log, codehost, repoNames }) {
  const prs = item._prs || [];
  const ch = codehost;

  if (prs.length === 0) {
    return { type: 'error', error: 'No PRs to merge', prs: [] };
  }

  log(`Merging ${prs.length} approved PR(s)`);

  const merged = [];
  let mergeError = null;

  for (const { repo, prNumber } of prs) {
    try {
      try {
        const state = ch.getPRState(prNumber, { repo });
        if (state === 'MERGED') {
          log(`PR #${prNumber} in ${repo} already merged — skipping`);
          merged.push({ repo, prNumber });
          continue;
        }
        if (state !== 'OPEN') {
          mergeError = new Error(`PR #${prNumber} in ${repo} is ${state.toLowerCase()}, cannot merge`);
          log(mergeError.message);
          break;
        }
      } catch {}

      runHook('onBeforeMerge', config, { prNumber, repo });
      ch.mergePR(prNumber, { repo });

      // Verify the merge actually succeeded
      try {
        const postState = ch.getPRState(prNumber, { repo });
        if (postState !== 'MERGED') {
          mergeError = new Error(`PR #${prNumber} in ${repo} merge call succeeded but state is ${postState}, not MERGED`);
          log(mergeError.message);
          break;
        }
      } catch {}

      merged.push({ repo, prNumber });
      log(`merged PR #${prNumber} in ${repo}`);
      try { runHook('onMerged', config, { prNumber, repo }); } catch (err) {
        log(`warning: onMerged hook failed: ${err.message}`);
      }
    } catch (err) {
      mergeError = err;
      log(`merge failed for PR #${prNumber} in ${repo}: ${err.message}`);
      break;
    }
  }

  const allMerged = merged.length === prs.length;

  if (allMerged) {
    // Collect PR details for summary
    let prDetails = [];
    try {
      for (const { repo, prNumber } of prs) {
        const files = ch.getPRFiles(prNumber, { repo });
        const commits = ch.getPRCommits(prNumber, { repo });
        prDetails.push({ repo, prNumber, files, commits });
      }
    } catch (err) {
      log(`warning: failed to gather PR details: ${err.message}`);
    }

    // Post summary
    const primaryRepoName = repoNames?.[0] || prs[0]?.repo;
    const issueId = item._issueId;
    try {
      const sections = [];
      for (const { repo, prNumber, files, commits } of prDetails) {
        const repoShort = repo.split('/').pop();
        const totalAdditions = files.reduce((s, f) => s + (f.additions || 0), 0);
        const totalDeletions = files.reduce((s, f) => s + (f.deletions || 0), 0);
        const commitLines = commits.map(c => {
          const headline = c.messageHeadline || c.message?.split('\n')[0] || '';
          return `- ${headline}`;
        }).join('\n');
        const fileLines = files.map(f => `- \`${f.path}\``).join('\n');
        sections.push([
          `### \`${repoShort}\` — ${repo}#${prNumber}`,
          '**Commits:**', commitLines, '',
          `${files.length} file${files.length !== 1 ? 's' : ''} changed (+${totalAdditions} −${totalDeletions})`,
          '<details><summary>Files</summary>', '', fileLines, '', '</details>',
        ].join('\n'));
      }
      ch.botComment(issueId, { repo: primaryRepoName, body: `Shipped\n\n${sections.join('\n\n')}` });
      log(`posted summary on issue #${issueId}`);
    } catch (err) {
      log(`warning: failed to post issue summary: ${err.message}`);
    }

    return { type: 'success', prs: merged, prDetails };
  } else {
    if (merged.length > 0) {
      log(`partial merge: ${merged.length}/${prs.length} PRs merged before failure`);
    }
    return { type: 'error', error: mergeError?.message, prs: merged };
  }
}
