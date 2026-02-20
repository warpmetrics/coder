import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
  writeFileSync(join(configDir, MEMORY_FILE), content);
}
