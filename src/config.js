import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

export const CONFIG_DIR = '.warp-coder';
const CONFIG_FILE = 'config.json';
const ENV_FILE = '.env';

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

function loadEnv(dir) {
  const envPath = join(dir, ENV_FILE);
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

export function loadConfig(cwd = process.cwd()) {
  const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun "warp-coder init" to create one.`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  // Load secrets from .env in project root
  const env = loadEnv(cwd);
  if (env.WARP_CODER_WARPMETRICS_KEY) raw.warpmetricsApiKey = env.WARP_CODER_WARPMETRICS_KEY;
  if (env.WARP_CODER_LINEAR_KEY && raw.board) raw.board.apiKey = env.WARP_CODER_LINEAR_KEY;
  if (env.WARP_CODER_REVIEW_TOKEN) raw.reviewToken = env.WARP_CODER_REVIEW_TOKEN;

  // Warn if secrets are missing
  if (!raw.warpmetricsApiKey) {
    console.warn('warning: WARP_CODER_WARPMETRICS_KEY not set in .env — telemetry and state tracking disabled');
  }
  if (raw.board?.provider === 'linear' && !raw.board?.apiKey) {
    console.warn('warning: WARP_CODER_LINEAR_KEY not set in .env — Linear board adapter will fail');
  }

  // Normalize repos: support both "repo" (string) and "repos" (array)
  if (!raw.repos && raw.repo) {
    raw.repos = [raw.repo];
  }
  if (!raw.repos?.length) {
    throw new Error('Config must specify "repo" or "repos".');
  }

  return raw;
}
