import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = '.warp-coder';
const CONFIG_FILE = 'config.json';

export function loadConfig(cwd = process.cwd()) {
  const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun "warp-coder init" to create one.`);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}
