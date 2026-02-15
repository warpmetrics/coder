#!/usr/bin/env node

import { createInterface } from 'readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerClassifications } from '../src/warp.js';
import { discoverProjectFields } from '../src/boards/github-projects.js';
import { loadMemory } from '../src/memory.js';
import { reflect } from '../src/reflect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultsDir = join(__dirname, '..', 'defaults');

const command = process.argv[2];

if (command === 'watch') {
  const { watch } = await import('../src/watch.js');
  await watch();
} else if (command === 'init') {
  await runInit();
} else if (command === 'memory') {
  const configDir = join(process.cwd(), '.warp-coder');
  const memory = loadMemory(configDir);
  console.log(memory || '(no memory yet)');
} else if (command === 'compact') {
  const configDir = join(process.cwd(), '.warp-coder');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  console.log('Compacting memory...');
  await reflect({ configDir, step: 'compact', success: true, maxLines: config.memory?.maxLines || 100 });
  console.log('Done.');
} else {
  console.log('');
  console.log('  warp-coder — local agent loop for implementing GitHub issues');
  console.log('');
  console.log('  Usage:');
  console.log('    warp-coder init      Set up config for a project');
  console.log('    warp-coder watch     Start the poll loop');
  console.log('    warp-coder memory    Print current memory file');
  console.log('    warp-coder compact   Force-rewrite memory file');
  console.log('');
  process.exit(command ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Init wizard
// ---------------------------------------------------------------------------

async function runInit() {
  const log = msg => console.log(msg);

  log('');
  log('  warp-coder — set up agent config');
  log('');

  // 1. Ensure gh has the right scopes (before readline takes over stdin)
  log('  Ensuring GitHub CLI has required scopes (project, repo)...');
  try {
    execSync('gh auth refresh -s project,repo', { stdio: 'inherit' });
    log('  \u2713 GitHub CLI scopes updated');
  } catch {
    log('  \u26a0 Could not refresh gh scopes — run manually: gh auth refresh -s project,repo');
  }
  log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  try {
    // 2. WarpMetrics API key
    const wmKey = await ask('  ? WarpMetrics API key (get one at warpmetrics.com/app/api-keys): ');
    if (wmKey && !wmKey.startsWith('wm_')) {
      log('  \u26a0 Warning: key doesn\'t start with wm_ — make sure this is a valid WarpMetrics API key');
    }
    log('');

    // 3. Repo URL
    let repoDefault = '';
    try {
      repoDefault = execSync('git remote get-url origin', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {}
    const repoPrompt = repoDefault ? `  ? Repository URL (${repoDefault}): ` : '  ? Repository URL: ';
    const repoInput = await ask(repoPrompt);
    const repo = repoInput || repoDefault;
    if (!repo) {
      log('  \u2717 Repository URL is required');
      process.exit(1);
    }
    log('');

    // 4. Board provider
    log('  Board: GitHub Projects v2');
    const projectNumber = await ask('  ? Project number: ');
    if (!projectNumber) {
      log('  \u2717 Project number is required');
      process.exit(1);
    }

    // Try to infer owner from repo URL
    let ownerDefault = '';
    const match = repo.match(/github\.com[:/]([^/]+)\//);
    if (match) ownerDefault = match[1];
    const ownerPrompt = ownerDefault ? `  ? Project owner (${ownerDefault}): ` : '  ? Project owner: ';
    const ownerInput = await ask(ownerPrompt);
    const owner = ownerInput || ownerDefault;
    log('');

    // 5. Discover field IDs and column names
    let columns = { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', done: 'Done', blocked: 'Blocked' };
    try {
      log('  Discovering project fields...');
      const fields = discoverProjectFields(parseInt(projectNumber, 10), owner);
      const statusField = fields.find(f => f.name === 'Status');
      if (statusField?.options) {
        const available = statusField.options.map(o => o.name);
        log(`  Found columns: ${available.join(', ')}`);
        // Map available columns to our column keys, keeping defaults for any not found
        for (const key of Object.keys(columns)) {
          if (!available.includes(columns[key])) {
            log(`  \u26a0 Column "${columns[key]}" not found in project`);
          }
        }
      }
      log('');
    } catch (err) {
      log(`  \u26a0 Could not discover fields: ${err.message}`);
      log('  Using default column names');
      log('');
    }

    // 6. Build config
    const config = {
      board: {
        provider: 'github-projects',
        project: parseInt(projectNumber, 10),
        owner,
        columns,
      },
      hooks: {},
      claude: {
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        maxTurns: 20,
      },
      pollInterval: 30,
      maxRevisions: 3,
      repo,
    };

    if (wmKey) {
      config.warpmetricsApiKey = wmKey;
    }

    // 7. Write config
    const configDir = '.warp-coder';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    log(`  \u2713 ${configDir}/config.json created`);

    // 8. Add to .gitignore
    const gitignorePath = '.gitignore';
    const entry = '.warp-coder/';
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.split('\n').some(line => line.trim() === entry)) {
        writeFileSync(gitignorePath, content.trimEnd() + '\n' + entry + '\n');
        log(`  \u2713 Added ${entry} to .gitignore`);
      } else {
        log(`  \u2713 ${entry} already in .gitignore`);
      }
    } else {
      writeFileSync(gitignorePath, entry + '\n');
      log(`  \u2713 Created .gitignore with ${entry}`);
    }

    // 9. Register outcome classifications
    if (wmKey) {
      log('  Registering outcome classifications with WarpMetrics...');
      try {
        await registerClassifications(wmKey);
        log('  \u2713 Outcomes configured');
      } catch (err) {
        log(`  \u26a0 Some classifications failed: ${err.message}`);
        log('  You can set them manually in the WarpMetrics dashboard');
      }
    }

    // 10. Next steps
    log('');
    log('  Done! Next steps:');
    log('  1. Run: warp-coder watch');
    log('  2. Add issues to the "Ready" column of your project board');
    log('  3. View pipeline analytics at https://app.warpmetrics.com');
    log('');
  } finally {
    rl.close();
  }
}
