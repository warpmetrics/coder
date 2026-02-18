// Changelog provider — abstracts where changelog entries are stored.
// Providers: "warpmetrics" (POST to API), "file" (write to local JSON files).

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Prompts (shared between watch.js merge-time and release.js preview)
// ---------------------------------------------------------------------------

export const PUBLIC_PROMPT = `You are writing a public changelog entry for end users of WarpMetrics.

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

export const PRIVATE_PROMPT = `You are writing an internal/private changelog entry for the engineering team.

Given the technical context below, write a changelog entry with:
- title: Short technical title describing the change
- summary: One sentence technical summary
- content: Full technical details in markdown — include repo names, file paths, architectural decisions, everything relevant

Respond with valid JSON only: { "title": "...", "summary": "...", "content": "...", "tags": ["feature"|"fix"|"improvement"|"internal"] }`;

// ---------------------------------------------------------------------------
// Entry generation (shared helper)
// ---------------------------------------------------------------------------

export function generateChangelogEntry(execFileSync, prompt) {
  try {
    const result = execFileSync('claude', [
      '-p', prompt,
      '--max-turns', '1',
      '--model', 'sonnet',
      '--no-session-persistence',
    ], { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.summary || !parsed.content) return null;
    return parsed;
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    console.log(`  changelog entry generation error: ${err.message}${stderr ? `\n  stderr: ${stderr.slice(0, 500)}` : ''}`);
    return null;
  }
}

export function createChangelogProvider(config) {
  const changelog = config.changelog;
  if (!changelog?.provider) return null;

  if (changelog.provider === 'warpmetrics') {
    return createWarpmetricsProvider(changelog);
  }

  if (changelog.provider === 'file') {
    return createFileProvider(changelog);
  }

  return null;
}

function createWarpmetricsProvider({ url, token }) {
  const apiUrl = url || 'https://api.warpmetrics.com';

  return {
    async post({ title, summary, content, visibility, tags }) {
      const res = await fetch(`${apiUrl}/v1/changelog`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, summary, content, visibility, tags }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Changelog API ${res.status}: ${text}`);
      }

      const data = await res.json();
      return data.data;
    },
  };
}

function createFileProvider({ path: dir }) {
  const outDir = dir || './changelogs';

  return {
    async post({ title, summary, content, visibility, tags }) {
      mkdirSync(outDir, { recursive: true });

      // Append to a JSONL file per visibility
      const file = join(outDir, `${visibility}.jsonl`);
      const entry = {
        title,
        summary,
        content,
        visibility,
        tags,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
      return entry;
    },
  };
}
