#!/usr/bin/env node

import { createInterface } from 'readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { registerClassifications } from '../src/client/warp.js';
import { CONFIG_DIR } from '../src/config.js';
import { discoverProjectFields } from '../src/boards/github.js';
import { loadMemory } from '../src/agent/memory.js';
import { reflect } from '../src/agent/reflect.js';

const command = process.argv[2];

if (command === 'watch') {
  const { watch } = await import('../src/commands/watch.js');
  await watch();
} else if (command === 'init') {
  await runInit();
} else if (command === 'memory') {
  const configDir = join(process.cwd(), CONFIG_DIR);
  const memory = loadMemory(configDir);
  console.log(memory || '(no memory yet)');
} else if (command === 'release') {
  const preview = process.argv.includes('--preview');
  if (preview) {
    const { releasePreview } = await import('../src/commands/release.js');
    await releasePreview();
  } else {
    const { release } = await import('../src/commands/release.js');
    await release();
  }
} else if (command === 'debug') {
  const { debug } = await import('../src/commands/debug.js');
  await debug(process.argv.slice(3));
} else if (command === 'compact') {
  const configDir = join(process.cwd(), CONFIG_DIR);
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
  console.log('    warp-coder release             Release shipped issues (packages + deploys)');
  console.log('    warp-coder release --preview   Preview changelog entries without releasing');
  console.log('    warp-coder debug [issue#] [--title "..."]  Interactive state machine testing');
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
  // Need 'project' (read:project is not enough) and 'repo'
  log('  Checking GitHub CLI scopes...');
  try {
    let authOutput = '';
    try {
      authOutput = execSync('gh auth status 2>&1', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      authOutput = err.stdout || err.stderr || '';
    }
    const scopesMatch = authOutput.match(/Token scopes:\s*(.+)/i);
    const scopeList = (scopesMatch?.[1]?.match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
    const missing = ['project', 'repo'].filter(s => !scopeList.includes(s));

    if (missing.length === 0) {
      log('  \u2713 GitHub CLI scopes OK');
    } else {
      log(`  Missing scopes: ${missing.join(', ')}`);
      execSync(`gh auth refresh -s ${missing.join(',')}`, { stdio: 'inherit' });
      log('  \u2713 GitHub CLI scopes updated');
    }
  } catch {
    log('  \u26a0 Could not verify gh scopes — run manually: gh auth refresh -s project,repo');
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

    // 2b. Review token (optional — for submitting PR reviews from a separate account)
    const reviewToken = await ask('  ? Review token (GitHub PAT for a bot account, optional — press Enter to skip): ');
    log('');

    // 3. Repo URLs
    let repoDefault = '';
    try {
      repoDefault = execSync('git remote get-url origin', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {}
    const repos = [];
    log('  Add repository URLs (empty line to finish):');
    let repoIdx = 1;
    while (true) {
      const hint = repoIdx === 1 && repoDefault ? ` (${repoDefault})` : '';
      const input = await ask(`  ? Repo ${repoIdx}${hint}: `);
      const val = input || (repoIdx === 1 ? repoDefault : '');
      if (!val) break;
      repos.push(val);
      repoIdx++;
    }
    if (repos.length === 0) {
      log('  \u2717 At least one repository URL is required');
      process.exit(1);
    }
    const repo = repos[0];
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
    let columns = { todo: 'Todo', inProgress: 'In Progress', inReview: 'In Review', deploy: 'Deploy', done: 'Done', blocked: 'Blocked', waiting: 'Waiting' };
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
        provider: 'github',
        project: parseInt(projectNumber, 10),
        owner,
        columns,
      },
      hooks: {},
      claude: {
        maxTurns: 20,
      },
      pollInterval: 30,
      maxRevisions: 3,
      repos,
    };

    // 7. Write config + .env
    const configDir = CONFIG_DIR;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    log(`  \u2713 ${configDir}/config.json created`);

    const envVars = {};
    if (wmKey) envVars.WARP_CODER_WARPMETRICS_KEY = wmKey;
    if (reviewToken) envVars.WARP_CODER_REVIEW_TOKEN = reviewToken;

    if (Object.keys(envVars).length > 0) {
      const envPath = '.env';
      let existing = '';
      if (existsSync(envPath)) existing = readFileSync(envPath, 'utf-8');

      for (const [key, value] of Object.entries(envVars)) {
        if (!existing.includes(key)) {
          existing = existing.trimEnd() + (existing ? '\n' : '') + `${key}=${value}\n`;
          log(`  \u2713 Added ${key} to .env`);
        } else {
          log(`  \u2713 ${key} already in .env`);
        }
      }

      writeFileSync(envPath, existing);
      if (!existsSync(envPath + '.bak')) log(`  \u2713 .env updated`);
    }

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
