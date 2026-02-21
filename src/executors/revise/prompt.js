// Prompt templates for the revise executor.

export function buildRevisePrompt({ repoDirs, contextRepos, memory, reviewSection }) {
  const parts = [];
  const dirList = repoDirs.map(r => `  - ${r.dirName}/ (${r.name}) — PR #${r.prNumber}`).join('\n');
  parts.push('Repos with PRs (already cloned):', dirList, '');

  if (contextRepos.length > 0) {
    parts.push('Other repos available for reference if needed:', '');
    for (const cr of contextRepos) {
      parts.push(`  git clone ${cr.url} ${cr.dirName}`);
    }
    parts.push('');
  }

  if (memory) {
    parts.push('Lessons learned from previous tasks in this repository:', '', memory, '');
  }

  if (reviewSection) {
    parts.push('A code review has been submitted. Here is the feedback:', '', reviewSection);
  } else {
    parts.push('A code review has been submitted but no comments could be fetched — check the PR manually.', '');
  }

  parts.push(
    'Your job:', '',
    '1. Apply the suggested fixes',
    '2. Run tests to make sure everything passes',
    '3. Commit all changes with a message like "Address review feedback" — this is critical, do not skip the commit', '',
    'Do NOT open a new PR — just implement the fixes and commit.',
  );

  if (repoDirs.length > 1) {
    parts.push('Commit separately in each repo that needs changes.');
  }

  return parts.join('\n');
}
