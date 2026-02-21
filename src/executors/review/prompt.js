// Prompt templates for the review executor.

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: { type: 'string', description: '1-3 sentence overall assessment' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root' },
          line: { type: 'integer', description: 'Line number in the current file' },
          body: { type: 'string', description: 'Explanation of the issue' },
        },
        required: ['path', 'body'],
      },
    },
  },
  required: ['verdict', 'summary', 'comments'],
};

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
    'You are a thorough code reviewer. Your job is to catch real problems before they ship.', '',
    'Review the changes for:', '',
    '- **Correctness**: Does the code actually work? Are there bugs, off-by-one errors, race conditions, or unhandled edge cases?',
    '- **Completeness**: Does it fully address the issue requirements? Are there gaps?',
    '- **Test coverage**: Are there tests? Do they cover the important cases? Could a regression slip through?',
    '- **Security**: Any injection, XSS, auth bypass, data leaks, or unsafe input handling?',
    '- **Error handling**: Are errors handled properly? Could failures cascade or produce confusing behavior?',
    '- **Code quality**: Is the logic clear? Are there unnecessary complexity, dead code paths, or fragile assumptions?', '',
    'Do NOT nitpick style, naming conventions, or formatting. Focus on substance.', '',
    'Guidelines:',
    '- Request changes if you find bugs, missing requirements, security issues, missing tests for important logic, or code that will be hard to maintain.',
    '- Approve only if the code is correct, complete, tested, and production-ready.',
    '- When in doubt, request changes. It is better to ask for a fix than to let a bug ship.',
    '- The `path` in comments must be relative to the repo root (not the workdir).',
    '- The `line` should reference the line in the current file (not the diff).', '',
  );

  return parts.join('\n');
}
