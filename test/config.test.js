import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repoName, deriveRepoDirNames } from '../src/config.js';

describe('repoName', () => {
  it('extracts owner/name from HTTPS URL', () => {
    assert.equal(repoName('https://github.com/warpmetrics/frontend.git'), 'warpmetrics/frontend');
  });

  it('extracts owner/name from SSH URL', () => {
    assert.equal(repoName('git@github.com:warpmetrics/api.git'), 'warpmetrics/api');
  });

  it('strips .git suffix', () => {
    assert.equal(repoName('https://github.com/org/repo.git'), 'org/repo');
  });

  it('handles URL without .git suffix', () => {
    assert.equal(repoName('https://github.com/org/repo'), 'org/repo');
  });
});

describe('deriveRepoDirNames', () => {
  it('uses basename when unique', () => {
    const names = deriveRepoDirNames([
      'git@github.com:warpmetrics/frontend.git',
      'git@github.com:warpmetrics/api.git',
    ]);
    assert.deepEqual(names, ['frontend', 'api']);
  });

  it('uses full path when basenames collide', () => {
    const names = deriveRepoDirNames([
      'git@github.com:org-a/api.git',
      'git@github.com:org-b/api.git',
    ]);
    assert.deepEqual(names, ['org-a-api', 'org-b-api']);
  });

  it('handles single repo', () => {
    const names = deriveRepoDirNames(['git@github.com:warpmetrics/frontend.git']);
    assert.deepEqual(names, ['frontend']);
  });
});
