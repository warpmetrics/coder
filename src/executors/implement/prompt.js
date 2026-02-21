// Prompt templates for the implement executor.

export function classifyIntentPrompt(message) {
  return `Classify this message's intent. Reply with exactly one word: PROPOSE or IMPLEMENT.

PROPOSE = the user asks for analysis, review, proposal, plan, or discussion BEFORE making changes. They want to talk first.
IMPLEMENT = direct feature requests, bug fixes, confirmations, approvals, or instructions to build/change/add something.

If the message contains BOTH a request to implement AND a request to plan/propose first, choose PROPOSE — planning before implementing takes priority.

When in doubt, choose IMPLEMENT.

Message:
${message}`;
}

export const IMPLEMENT_RESUME = 'You were interrupted because you hit the turn limit. Your previous work is intact in the working directory. Continue where you left off — finish implementing, run tests, and commit.';

export function buildImplementPrompt({
  workdir, repos, repoNames, dirNames,
  primaryDirName, primaryRepoName, branch,
  issueId, issueTitle, issueBody,
  memory, commentsText, shouldPropose,
}) {
  const parts = [];

  parts.push(
    '## Workspace layout', '',
    `Root directory: ${workdir}`,
    'Repos are cloned as subdirectories of the root:', '',
    `  ${workdir}/                  ← root (NOT a git repo)`,
    `    ${primaryDirName}/   ← ${primaryRepoName} (already cloned)`,
    ...repos.slice(1).map((_, i) => `    ${dirNames[i + 1]}/   ← ${repoNames[i + 1]} (clone if needed)`),
    '',
    'Decide which repo(s) to work in based on the task.', '',
  );

  if (repos.length > 1) {
    const otherRepoLines = [];
    for (let i = 1; i < repos.length; i++) {
      otherRepoLines.push(`  # ${repoNames[i]} — clone into the root, NOT inside another repo`);
      otherRepoLines.push(`  cd ${workdir} && git clone ${repos[i]} ${dirNames[i]} && cd ${dirNames[i]} && git checkout -b ${branch}`);
    }
    parts.push(
      `If any part of the issue could involve another repo — even just to understand how something works — clone it and investigate before deciding on an approach. Do not guess at behavior you can verify by reading the code.`, '',
      ...otherRepoLines, '',
      `IMPORTANT: These repos are SEPARATE git repositories cloned as siblings under ${workdir}/. Never clone one repo inside another.`, '',
    );
  }

  if (memory) {
    parts.push('Lessons learned from previous tasks in this repository:', '', memory, '');
  }

  if (commentsText) {
    parts.push('Discussion on the issue:', '', commentsText, '');
  }

  parts.push(
    `## Task`, '',
    `You are working on issue #${issueId}: "${issueTitle}" and ONLY this issue.`,
    'All issue context (body, comments, user feedback) is provided above — do NOT use `gh` to fetch issues, PRs, or comments.',
    'Ignore branches, PRs, or code changes related to other issues you may find in the repo.', '',
    issueBody, '',
  );

  if (shouldPropose) {
    parts.push(
      'The user is asking you to analyze or propose rather than directly implement.',
      'DO NOT make code changes. Research the codebase, analyze the request, and present your proposal or plan.',
      'The user will reply on the issue and you will be resumed with their response.', '',
    );
  } else {
    parts.push(
      'Proceed with these steps:', '',
      ...(repos.length > 1
        ? ['1. Clone any other repos that could be relevant (see commands above)', '2. Read the codebase to understand relevant context']
        : ['1. Read the codebase to understand relevant context']
      ),
      `${repos.length > 1 ? '3' : '2'}. Implement the changes`,
      `${repos.length > 1 ? '4' : '3'}. Run tests to verify nothing is broken`,
      `${repos.length > 1 ? '5' : '4'}. Commit all changes with a clear message — this is critical, do not skip the commit`, '',
      'Important: commit separately in each repo that has changes. Do NOT push or open PRs.', '',
    );
  }

  parts.push(
    '## Efficiency', '',
    'You have a limited turn budget. Use subagents (the Task tool) aggressively:',
    '- Research multiple repos or files in parallel instead of sequentially',
    '- Delegate codebase exploration to subagents while you plan',
    '- Run tests in background subagents while you continue working',
    '- Use subagents for any read-heavy task (finding usages, understanding patterns)',
    'Each subagent call counts as one turn regardless of how much work it does internally.',
  );

  return parts.join('\n');
}
