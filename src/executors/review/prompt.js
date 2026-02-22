// Prompt templates for the review executor.

import { z } from 'zod';

// Verdict values with descriptions — single source of truth.
export const VERDICTS = {
  approve: 'Code is correct, complete, and ready to merge',
  request_changes: 'Bugs, security issues, missing requirements, or design inconsistencies that must be fixed',
};

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(Object.keys(VERDICTS)),
  summary: z.string().describe('1-3 sentence overall assessment'),
  comments: z.array(z.object({
    path: z.string().describe('File path relative to repo root'),
    line: z.int().optional().describe('Line number in the NEW version of the file, must be within a changed diff hunk'),
    body: z.string().describe('Explanation of the issue'),
  })),
});

export const REVIEW_SCHEMA = z.toJSONSchema(ReviewVerdictSchema);

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
    '### Verdict rules', '',
    ...Object.entries(VERDICTS).map(([val, desc]) => `- \`${val}\`: ${desc}`),
    '',
    '### Skills', '',
    'Before starting, look for PR review skill files in `.claude/skills/`. Read any SKILL.md files you find — they contain project-specific review criteria that inform your verdict.', '',
    '### Workflow', '',
    '1. **Read review skills**: Check `.claude/skills/` for SKILL.md files and read them.',
    '2. **Start with the diff overview**: Run `git diff origin/main...HEAD --stat` in each repo to see which files changed.',
    '3. **Drill into specific files**: Run `git diff origin/main...HEAD -- path/to/file.js` to see the actual changes for files that matter.',
    '4. **Spot-check context**: Read surrounding code only when needed to verify correctness (imports, callers, types).',
    '5. **Produce your JSON verdict.** Once you have enough information, output the verdict. Do not delay to explore further.', '',
    '## CRITICAL RULES', '',
    'This is a READ-ONLY review. You MUST NOT:', '',
    '- Modify any files (no Edit, no Write)',
    '- Run `gh` commands',
    '- Run builds, tests, linters, or any other processes', '',
    'You MAY use Bash for `git diff`, `git log`, `git show`, and similar read-only git commands.',
    'You MAY use the Read tool to inspect source files.', '',
    '## Output', '',
    'After your analysis, output a JSON verdict as your FINAL message. The JSON must be in a ```json fenced code block.',
    'The JSON verdict MUST be your absolute last output. Do NOT use any tools or produce any text after the JSON block.', '',
    '### JSON Schema', '',
    '```json',
    JSON.stringify(REVIEW_SCHEMA, null, 2),
    '```', '',
    '### Line number rules (STRICT)', '',
    '- The `line` field refers to the line number in the NEW version of the file (the + side of the diff).',
    '- ONLY include `line` if the line is inside a changed diff hunk. If the issue is about a line outside any hunk (e.g. unchanged code, deleted code, or a general file-level concern), OMIT the `line` field entirely.',
    '- NEVER use line numbers from the old file, from deleted lines, or from context lines outside hunks.',
    '- When in doubt, omit `line`. A comment without a line number is always valid.', '',
  );

  return parts.join('\n');
}
