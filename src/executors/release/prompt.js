// Prompt templates for changelog generation.

import { z } from 'zod';

export const ChangelogEntrySchema = z.object({
  title: z.string().describe('Short title describing the change'),
  entry: z.string().describe('Markdown description of what changed'),
  tags: z.array(z.enum(['feature', 'fix', 'improvement', 'internal'])).describe('Categories for this change'),
});

export const CHANGELOG_ENTRY_SCHEMA = z.toJSONSchema(ChangelogEntrySchema);

export const PUBLIC_CHANGELOG = `You are writing a public changelog entry for end users of WarpMetrics.

Given the technical context below, write a changelog entry with:
- title: Short, user-facing title (e.g. "Faster dashboard loading", "New export options")
- entry: 2-4 paragraphs of markdown describing what changed and why it matters to users

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
- If the change is purely internal with no user-visible impact, set title to "Internal improvements" and summarize briefly`;

export const PRIVATE_CHANGELOG = `You are writing an internal/private changelog entry for the engineering team.

Given the technical context below, write a changelog entry with:
- title: Short technical title describing the change
- entry: Full technical details in markdown — include repo names, file paths, architectural decisions, everything relevant`;
