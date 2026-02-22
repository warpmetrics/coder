// Merge executor: merges approved PRs via PR client.

import { runHook } from '../../agent/hooks.js';

export const definition = {
  name: 'merge',
  resultTypes: ['success', 'error'],
  effects: {
    async success(run, result, ctx) {
      const { config, clients: { notify } } = ctx;
      notify.comment(run.issueId, {
        repo: config.repoNames[0], runId: run.id, title: run.title,
        body: `Merged successfully. Move to **Deploy** to trigger deployment.`,
      });
    },
  },
  create() {
    return async (run, ctx) => {
      const { config, clients, context } = ctx;
      const prs = context.actOpts?.prs || [];
      const item = run.boardItem || { _issueId: run.issueId, _prs: prs, content: { title: run.title } };
      if (prs.length && !item._prs) item._prs = prs;
      item._runId = run.id;
      const r = await merge(item, { config, clients, context });

      if (r.type === 'success') {
        return { ...r, outcomeOpts: { prNumber: prs[0]?.prNumber },
          nextActOpts: { prs, release: context.actOpts?.release } };
      }
      const retryPrs = r.failedPrs?.length ? r.failedPrs : prs;
      return { ...r, outcomeOpts: { prNumber: prs[0]?.prNumber },
        nextActOpts: { prs: retryPrs, release: context.actOpts?.release } };
    };
  },
};

export async function merge(item, ctx) {
  const { config, clients: { prs, notify, log } } = ctx;
  const repoNames = config.repoNames;
  const prList = item._prs || [];
  const ch = prs;

  if (prList.length === 0) {
    return { type: 'error', error: 'No PRs to merge', prs: [] };
  }

  log(`Merging ${prList.length} approved PR(s)`);

  const merged = [];
  let mergeError = null;

  for (const { repo, prNumber } of prList) {
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
      } catch (err) { log(`  warning: pre-merge state check failed for ${repo}#${prNumber}: ${err.message}`); }

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
      } catch (err) { log(`  warning: post-merge state check failed for ${repo}#${prNumber}: ${err.message}`); }

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

  const allMerged = merged.length === prList.length;

  if (allMerged) {
    // Collect PR details for summary
    let prDetails = [];
    try {
      for (const { repo, prNumber } of prList) {
        const files = ch.getPRFiles(prNumber, { repo });
        const commits = ch.getPRCommits(prNumber, { repo });
        prDetails.push({ repo, prNumber, files, commits });
      }
    } catch (err) {
      log(`warning: failed to gather PR details: ${err.message}`);
    }

    // Post summary
    const primaryRepoName = repoNames?.[0] || prList[0]?.repo;
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
      notify.comment(issueId, { repo: primaryRepoName, runId: item._runId, title: item.content?.title, body: `Shipped\n\n${sections.join('\n\n')}` });
      log(`posted summary on issue #${issueId}`);
    } catch (err) {
      log(`warning: failed to post issue summary: ${err.message}`);
    }

    return { type: 'success', prs: merged, prDetails };
  } else {
    const failed = prList.filter(p => !merged.some(m => m.repo === p.repo && m.prNumber === p.prNumber));
    if (merged.length > 0) {
      log(`partial merge: ${merged.length}/${prList.length} PRs merged before failure`);
    }
    return { type: 'error', error: mergeError?.message, prs: merged, failedPrs: failed };
  }
}
