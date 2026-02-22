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
          line: { type: 'integer', description: 'Line number in the NEW version of the file, must be within a changed diff hunk' },
          body: { type: 'string', description: 'Explanation of the issue' },
        },
        required: ['path', 'body'],
      },
    },
  },
  required: ['verdict', 'summary', 'comments'],
};

export function buildReviewPrompt({
  workdir, repoDirs, issueId, issueTitle, issueBody, commentsText,
}) {
  const parts = [];

  parts.push(
    '## Workspace layout', '',
    `Root directory: ${workdir}`,
    'Repos are cloned as subdirectories of the root:', '',
    ...repoDirs.map(r => `  ${r.dirName}/ (${r.name}) — PR #${r.prNumber}, branch: ${r.branch}`),
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

  parts.push(
    '## Instructions', '',
    'You have full codebase access in the cloned repos. Explore the changes yourself using git and file reads.', '',
    '### Workflow', '',
    '1. **Start with the diff overview**: Run `git diff origin/main...HEAD --stat` in each repo to see which files changed.',
    '2. **Drill into specific files**: Run `git diff origin/main...HEAD -- path/to/file.js` to see the actual changes for files that matter.',
    '3. **Spot-check context**: Read surrounding code only when needed to verify correctness (imports, callers, types).',
    '4. **Produce your JSON verdict.** Once you have enough information, output the verdict. Do not delay to explore further.', '',
    '### What to review', '',
    '- **Correctness**: Bugs, off-by-one errors, race conditions, unhandled edge cases',
    '- **Completeness**: Does it fully address the issue requirements?',
    '- **Security**: Injection, XSS, auth bypass, data leaks, unsafe input handling',
    '- **Error handling**: Are errors handled properly?',
    '- **Code quality**: Unnecessary complexity, dead code paths, fragile assumptions', '',
    'Do NOT nitpick style, naming conventions, or formatting. Focus on substance.', '',
    '## CRITICAL RULES', '',
    'This is a READ-ONLY review. You MUST NOT:', '',
    '- Modify any files (no Edit, no Write)',
    '- Run `gh` commands',
    '- Run builds, tests, linters, or any other processes', '',
    'You MAY use Bash for `git diff`, `git log`, `git show`, and similar read-only git commands.',
    'You MAY use the Read tool to inspect source files.', '',
    '## Output', '',
    'After your analysis, output a JSON verdict as your FINAL message. The JSON must be in a ```json fenced code block.', '',
    '### JSON format', '',
    '```',
    '{',
    '  "verdict": "approve" or "request_changes",',
    '  "summary": "1-3 sentence overall assessment",',
    '  "comments": [',
    '    {',
    '      "path": "file path relative to repo root",',
    '      "line": <integer, line number in the NEW file version — ONLY if the line is inside a changed diff hunk, otherwise OMIT this field>,',
    '      "body": "explanation of the issue"',
    '    }',
    '  ]',
    '}',
    '```', '',
    '### Line number rules (STRICT)', '',
    '- The `line` field refers to the line number in the NEW version of the file (the + side of the diff).',
    '- ONLY include `line` if the line is inside a changed diff hunk. If the issue is about a line outside any hunk (e.g. unchanged code, deleted code, or a general file-level concern), OMIT the `line` field entirely.',
    '- NEVER use line numbers from the old file, from deleted lines, or from context lines outside hunks.',
    '- When in doubt, omit `line`. A comment without a line number is always valid.', '',
    '### Verdict rules (STRICT)', '',
    '- `request_changes`: ONLY for bugs, security vulnerabilities, or missing core requirements that would break functionality.',
    '- `approve`: For code that works correctly and meets requirements, even if there are minor suggestions or style preferences.',
    '- Minor issues, code smells, optional improvements, and follow-up suggestions are NOT grounds for requesting changes. Mention them in comments but still approve.',
    '- Be precise: if the diff shows a change was made, do not claim it was not made. Verify your claims against the actual diff output before writing them.', '',
  );

  return parts.join('\n');
}
