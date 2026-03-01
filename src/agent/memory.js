import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const MEMORY_FILE = 'memory.md';

export function loadMemory(configDir) {
  try {
    return readFileSync(join(configDir, MEMORY_FILE), 'utf-8');
  } catch {
    return '';
  }
}

export function saveMemory(configDir, content) {
  mkdirSync(configDir, { recursive: true });
  const dest = join(configDir, MEMORY_FILE);
  const tmp = dest + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, dest);
}
