import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

export const CONFIG_DIR = '.warp-coder';
const CONFIG_FILE = 'config.json';

export function repoName(url) {
  return url.replace(/\.git$/, '').replace(/^.*github\.com[:\/]/, '');
}

/**
 * Derive unique directory names for repos, handling basename collisions.
 * e.g. ["org/api", "other/api"] → ["org-api", "other-api"]
 */
export function deriveRepoDirNames(repos) {
  const names = repos.map(url => basename(repoName(url)));
  const hasDuplicates = new Set(names).size !== names.length;
  if (!hasDuplicates) return names;
  return repos.map(url => repoName(url).replace(/\//g, '-'));
}

export function loadConfig(cwd = process.cwd()) {
  const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun "warp-coder init" to create one.`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  // Normalize repos: support both "repo" (string) and "repos" (array)
  if (!raw.repos && raw.repo) {
    raw.repos = [raw.repo];
  }
  if (!raw.repos?.length) {
    throw new Error('Config must specify "repo" or "repos".');
  }

  return raw;
}
