#!/usr/bin/env node

import { createInterface } from 'readline';
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultsDir = join(__dirname, '..', 'defaults');

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function log(msg) {
  console.log(msg);
}

function getExistingSecrets() {
  try {
    execSync('gh --version', { stdio: 'ignore' });
  } catch {
    return null; // gh not available
  }
  try {
    const output = execSync('gh secret list', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const names = output.split('\n').map(line => line.split('\t')[0].trim()).filter(Boolean);
    return new Set(names);
  } catch {
    return new Set(); // gh available but couldn't list (e.g. no repo context)
  }
}

async function main() {
  log('');
  log('  warp-coder \u2014 Agent pipeline for implementing GitHub issues');
  log('');

  const existingSecrets = getExistingSecrets();
  const ghAvailable = existingSecrets !== null;

  // 1. Anthropic API key
  let anthropicKey = null;
  if (existingSecrets?.has('ANTHROPIC_API_KEY')) {
    log('  \u2713 ANTHROPIC_API_KEY already set');
    const replace = await ask('    Replace it? (y/N): ');
    if (replace.toLowerCase() === 'y') {
      anthropicKey = await ask('  ? Anthropic API key: ');
    }
  } else {
    anthropicKey = await ask('  ? Anthropic API key: ');
  }
  if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) {
    log('  \u26a0 Warning: key doesn\'t start with sk-ant- \u2014 make sure this is a valid Anthropic API key');
  }

  // 2. WarpMetrics API key
  let wmKey = null;
  if (existingSecrets?.has('WARPMETRICS_API_KEY')) {
    log('  \u2713 WARPMETRICS_API_KEY already set');
    const replace = await ask('    Replace it? (y/N): ');
    if (replace.toLowerCase() === 'y') {
      wmKey = await ask('  ? WarpMetrics API key (get one at warpmetrics.com/app/api-keys): ');
    }
  } else {
    wmKey = await ask('  ? WarpMetrics API key (get one at warpmetrics.com/app/api-keys): ');
  }
  if (wmKey && !wmKey.startsWith('wm_')) {
    log('  \u26a0 Warning: key doesn\'t start with wm_ \u2014 make sure this is a valid WarpMetrics API key');
  }

  log('');

  // 3. Set GitHub secrets
  if (ghAvailable) {
    if (anthropicKey) {
      try {
        execSync('gh secret set ANTHROPIC_API_KEY', { input: anthropicKey, stdio: ['pipe', 'ignore', 'ignore'] });
        log('  \u2713 ANTHROPIC_API_KEY set');
      } catch (e) {
        log(`  \u2717 Failed to set ANTHROPIC_API_KEY: ${e.message}`);
      }
    }
    if (wmKey) {
      try {
        execSync('gh secret set WARPMETRICS_API_KEY', { input: wmKey, stdio: ['pipe', 'ignore', 'ignore'] });
        log('  \u2713 WARPMETRICS_API_KEY set');
      } catch (e) {
        log(`  \u2717 Failed to set WARPMETRICS_API_KEY: ${e.message}`);
      }
    }
  } else {
    log('  gh (GitHub CLI) not found. Set these secrets manually:');
    log('');
    log('  gh secret set ANTHROPIC_API_KEY');
    log('  gh secret set WARPMETRICS_API_KEY');
    log('  (gh will prompt for the value interactively)');
  }
  log('');

  // 4. Copy workflows
  await copyWorkflow('agent-implement.yml');
  await copyWorkflow('agent-revise.yml');

  // 5. Copy scripts
  await copyScripts();

  log('');

  // 6. Register outcome classifications
  if (wmKey) {
    log('  Registering outcome classifications with WarpMetrics...');
    const classifications = [
      { name: 'PR Created', classification: 'success' },
      { name: 'Fixes Applied', classification: 'success' },
      { name: 'Issue Understood', classification: 'success' },
      { name: 'Needs Clarification', classification: 'neutral' },
      { name: 'Needs Human', classification: 'neutral' },
      { name: 'Implementation Failed', classification: 'failure' },
      { name: 'Tests Failed', classification: 'failure' },
      { name: 'Revision Failed', classification: 'failure' },
      { name: 'Max Retries', classification: 'failure' },
    ];

    let classOk = true;
    for (const { name, classification } of classifications) {
      try {
        const res = await fetch(`https://api.warpmetrics.com/v1/outcomes/classifications/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${wmKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ classification }),
        });
        if (!res.ok) {
          classOk = false;
          console.warn(`  \u26a0 Failed to set classification ${name}: ${res.status}`);
        }
      } catch (e) {
        classOk = false;
        console.warn(`  \u26a0 Failed to set classification ${name}: ${e.message}`);
      }
    }
    if (classOk) {
      log('  \u2713 Outcomes configured');
    } else {
      log('  \u26a0 Some classifications failed \u2014 you can set them manually in the WarpMetrics dashboard');
    }
  } else {
    log('  Skipping outcome classifications (WarpMetrics key not provided)');
  }

  // 7. Check for warp-review
  log('');
  if (!existsSync('.github/workflows/warp-review.yml')) {
    log('  \u26a0 warp-review not found. Install it for automated code reviews on agent PRs:');
    log('  npx @warpmetrics/review init');
  } else {
    log('  \u2713 warp-review detected \u2014 agent PRs will be reviewed automatically');
  }

  // 8. Print next steps
  log('');
  log('  Done! Next steps:');
  log('  1. git add .github/workflows .github/scripts');
  log('  2. git commit -m "Add warp-coder agent pipeline"');
  log('  3. Label a GitHub issue with "agent" to trigger implementation');
  log('  4. View pipeline analytics at https://app.warpmetrics.com');
  log('');

  rl.close();
}

async function copyWorkflow(filename) {
  const dest = `.github/workflows/${filename}`;
  if (existsSync(dest)) {
    const overwrite = await ask(`  ${filename} already exists. Overwrite? (y/N): `);
    if (overwrite.toLowerCase() !== 'y') {
      log(`  Skipping ${filename}`);
      return;
    }
  }
  mkdirSync('.github/workflows', { recursive: true });
  copyFileSync(join(defaultsDir, filename), dest);
  log(`  \u2713 ${dest} created`);
}

async function copyScripts() {
  const scriptsDir = '.github/scripts';
  if (existsSync(scriptsDir)) {
    const overwrite = await ask('  .github/scripts/ already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      log('  Skipping scripts');
      return;
    }
  }
  mkdirSync(scriptsDir, { recursive: true });
  const srcDir = join(defaultsDir, 'scripts');
  for (const file of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, file), join(scriptsDir, file));
  }
  log(`  \u2713 .github/scripts/ created (${readdirSync(srcDir).length} files)`);
}

main().catch(err => {
  console.error('init failed:', err.message);
  process.exitCode = 1;
  rl.close();
});
