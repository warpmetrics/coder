// Copy .warp-coder/skills/ into <workdir>/.claude/skills/ so Claude Code discovers them.

import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, cpSync } from 'fs';

const SKILLS_DIR = 'skills';

export function listSkills(configDir) {
  const src = join(configDir, SKILLS_DIR);
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
}

export function installSkills(configDir, workdir) {
  const src = join(configDir, SKILLS_DIR);
  if (!existsSync(src)) return 0;

  const entries = readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory());
  if (entries.length === 0) return 0;

  const dest = join(workdir, '.claude', SKILLS_DIR);
  mkdirSync(dest, { recursive: true });

  for (const entry of entries) {
    cpSync(join(src, entry.name), join(dest, entry.name), { recursive: true });
  }

  return entries.length;
}
