// Shared workspace helpers for executors.

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

export function gitExclude(dir, entries) {
  const file = join(dir, '.git', 'info', 'exclude');
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  const additions = entries.filter(e => !existing.includes(e));
  if (additions.length) writeFileSync(file, existing.trimEnd() + '\n' + additions.join('\n') + '\n');
}
