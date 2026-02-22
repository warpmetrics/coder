import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installSkills } from './skills.js';

const BASE = join(tmpdir(), `skills-test-${Date.now()}`);
const CONFIG_DIR = join(BASE, '.warp-coder');
const WORKDIR = join(BASE, 'workdir');

beforeEach(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(WORKDIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('installSkills', () => {

  it('returns 0 when no skills dir exists', () => {
    assert.equal(installSkills(CONFIG_DIR, WORKDIR), 0);
  });

  it('returns 0 when skills dir is empty', () => {
    mkdirSync(join(CONFIG_DIR, 'skills'), { recursive: true });
    assert.equal(installSkills(CONFIG_DIR, WORKDIR), 0);
  });

  it('copies skill folders into workdir/.claude/skills/', () => {
    const skillDir = join(CONFIG_DIR, 'skills', 'design');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: design\n---\n# Design');

    const count = installSkills(CONFIG_DIR, WORKDIR);

    assert.equal(count, 1);
    const dest = join(WORKDIR, '.claude', 'skills', 'design', 'SKILL.md');
    assert.ok(existsSync(dest));
    assert.ok(readFileSync(dest, 'utf-8').includes('name: design'));
  });

  it('copies multiple skills', () => {
    for (const name of ['design', 'testing']) {
      const dir = join(CONFIG_DIR, 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `# ${name}`);
    }

    const count = installSkills(CONFIG_DIR, WORKDIR);
    assert.equal(count, 2);
    assert.ok(existsSync(join(WORKDIR, '.claude', 'skills', 'design', 'SKILL.md')));
    assert.ok(existsSync(join(WORKDIR, '.claude', 'skills', 'testing', 'SKILL.md')));
  });

  it('ignores files in skills dir (only copies directories)', () => {
    mkdirSync(join(CONFIG_DIR, 'skills'), { recursive: true });
    writeFileSync(join(CONFIG_DIR, 'skills', 'README.md'), 'ignore me');

    assert.equal(installSkills(CONFIG_DIR, WORKDIR), 0);
  });
});
