// All prompt templates for LLM interactions.
// Templates are pure functions: accept context, return prompt strings.
// No dependencies on external modules — keep this file self-contained.

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

export function classifyIntentPrompt(message) {
  return `Classify this message's intent. Reply with exactly one word: PROPOSE or IMPLEMENT.

PROPOSE = the user asks for analysis, review, proposal, plan, or discussion BEFORE making changes. They want to talk first.
IMPLEMENT = direct feature requests, bug fixes, confirmations, approvals, or instructions to build/change/add something.

If the message contains BOTH a request to implement AND a request to plan/propose first, choose PROPOSE — planning before implementing takes priority.

When in doubt, choose IMPLEMENT.

Message:
${message}`;
}

// ---------------------------------------------------------------------------
// Implement (issue resolution)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Revise (code review feedback)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Review (PR code review)
// ---------------------------------------------------------------------------

export function buildReviewPrompt({
  workdir, repoDirs, diffs, issueId, issueTitle, issueBody, commentsText,
}) {
  const parts = [];

  parts.push(
    '## Workspace layout', '',
    `Root directory: ${workdir}`,
    'Repos are cloned as subdirectories of the root:', '',
    ...repoDirs.map(r => `  ${r.dirName}/ (${r.name}) — PR #${r.prNumber}`),
    '',
  );

  parts.push(
    '## Task', '',
    `You are reviewing a PR that implements issue #${issueId}: "${issueTitle}".`, '',
  );

  if (issueBody) {
    parts.push('### Issue requirements', '', issueBody, '');
  }

  if (commentsText) {
    parts.push('### Discussion on the issue', '', commentsText, '');
  }

  if (diffs) {
    parts.push('### Diffs', '');
    for (const d of diffs) {
      parts.push(`#### ${d.repo} PR #${d.prNumber}`, '', '```diff', d.diff, '```', '');
    }
  }

  parts.push(
    '## Instructions', '',
    'The diffs above are provided for context, but you have full codebase access in the cloned repos.',
    'Review the changes for:', '',
    '- **Correctness**: Does the code work as intended? Are there bugs?',
    '- **Completeness**: Does it fully address the issue requirements?',
    '- **Test coverage**: Are there tests? Do they cover edge cases?',
    '- **Security**: Any injection, XSS, auth bypass, or data leaks?',
    '- **Error handling**: Are errors handled properly?', '',
    'Do NOT nitpick style, naming, or formatting — focus on real bugs, missing functionality, and security issues.', '',
    'After reviewing, write your assessment as JSON to:', '',
    `  ${workdir}/.warp-coder-review`, '',
    'The JSON must have this shape:', '',
    '```json',
    '{',
    '  "verdict": "approve" or "request_changes",',
    '  "summary": "1-2 sentence overall assessment",',
    '  "comments": [{ "path": "relative/file.js", "line": 42, "body": "explanation" }]',
    '}',
    '```', '',
    'Guidelines:',
    '- Default to `approve` unless there are real bugs, missing requirements, or security issues.',
    '- If the implementation is correct but could be improved, approve with suggestions in comments.',
    '- The `path` in comments must be relative to the repo root (not the workdir).',
    '- The `line` should reference the line in the current file (not the diff).', '',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Changelog generation
// ---------------------------------------------------------------------------

export const PUBLIC_CHANGELOG = `You are writing a public changelog entry for end users of WarpMetrics.

Given the technical context below, write a changelog entry with:
- title: Short, user-facing title (e.g. "Faster dashboard loading", "New export options")
- summary: One sentence describing the change in plain language
- content: 2-4 paragraphs of markdown describing what changed and why it matters to users

CRITICAL RULES — violating any of these makes the entry unusable:
- NEVER mention repository names, file paths, function names, or class names
- NEVER mention internal architecture, database schemas, or infrastructure
- NEVER mention specific technologies (Prisma, Redis, Express, React, etc.) unless they are user-facing
- NEVER mention environment variables, config keys, API keys, or secrets
- NEVER mention team members, bot names, or internal tools
- NEVER mention PR numbers, commit hashes, or branch names
- NEVER mention server names, IP addresses, ports, or deployment details
- NEVER use developer jargon — write for a non-technical product user
- DO focus on user-visible impact: what can they do now? what's better? what's fixed?
- DO use clear, concise language a product manager would approve
- If the change is purely internal with no user-visible impact, set title to "Internal improvements" and summarize briefly

Respond with valid JSON only: { "title": "...", "summary": "...", "content": "...", "tags": ["feature"|"fix"|"improvement"|"internal"] }`;

export const PRIVATE_CHANGELOG = `You are writing an internal/private changelog entry for the engineering team.

Given the technical context below, write a changelog entry with:
- title: Short technical title describing the change
- summary: One sentence technical summary
- content: Full technical details in markdown — include repo names, file paths, architectural decisions, everything relevant

Respond with valid JSON only: { "title": "...", "summary": "...", "content": "...", "tags": ["feature"|"fix"|"improvement"|"internal"] }`;

// ---------------------------------------------------------------------------
// Memory reflection
// ---------------------------------------------------------------------------

export function buildReflectPrompt({ currentMemory, step, issue, prNumber, success, error, hookOutputs, reviewComments, claudeOutput, maxLines }) {
  const sections = [
    '# Reflect on this task and update the memory file.',
    '',
    `Step: ${step}`,
    `Outcome: ${success ? 'success' : 'failure'}`,
  ];

  if (issue) sections.push(`Issue: #${issue.number} — ${issue.title}`);
  if (prNumber) sections.push(`PR: #${prNumber}`);

  if (error) {
    sections.push('', '## Error', '```', truncate(error, 500), '```');
  }

  if (hookOutputs?.length) {
    sections.push('', '## Hook outputs');
    for (const h of hookOutputs) {
      sections.push(`### ${h.hook} (exit ${h.exitCode})`);
      const output = (h.stdout + h.stderr).trim();
      if (output) sections.push('```', truncate(output, 1000), '```');
    }
  }

  if (reviewComments?.length) {
    sections.push('', '## Review comments');
    for (const c of reviewComments) {
      sections.push(`- ${c.user?.login || 'reviewer'}: ${truncate(c.body || '', 200)}`);
    }
  }

  if (claudeOutput) {
    sections.push('', '## Claude output (truncated)', '```', truncate(String(claudeOutput), 1000), '```');
  }

  return [
    'You are a memory manager for an automated coding agent.',
    '',
    `Here is the agent's current memory file (lessons learned from past tasks):`,
    '',
    currentMemory ? '```\n' + currentMemory + '\n```' : '(no memory yet)',
    '',
    'Here is what just happened:',
    '',
    sections.join('\n'),
    '',
    'Instructions:',
    `- Output the COMPLETE updated memory file (markdown).`,
    `- Keep it under ${maxLines} lines.`,
    `- Preserve relevant existing lessons. Add new ones from this task.`,
    `- Remove lessons that are contradicted by new evidence.`,
    `- Be concise — each lesson should be 1-2 lines max.`,
    `- Group lessons by topic (e.g. "## Testing", "## Code patterns").`,
    `- Output ONLY the memory file content, no explanation.`,
  ].join('\n');
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\n... (truncated)';
}
