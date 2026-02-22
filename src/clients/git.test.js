import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenUrl } from './git.js';

describe('tokenUrl', () => {
  it('rewrites SSH URL to HTTPS with token', () => {
    const result = tokenUrl('git@github.com:org/repo.git', 'tok123');
    assert.equal(result, 'https://x-access-token:tok123@github.com/org/repo.git');
  });

  it('rewrites HTTPS URL with token', () => {
    const result = tokenUrl('https://github.com/org/repo.git', 'tok123');
    assert.equal(result, 'https://x-access-token:tok123@github.com/org/repo.git');
  });

  it('rewrites HTTPS URL without .git suffix', () => {
    const result = tokenUrl('https://github.com/org/repo', 'tok123');
    assert.equal(result, 'https://x-access-token:tok123@github.com/org/repo.git');
  });

  it('returns original URL when no token', () => {
    const url = 'git@github.com:org/repo.git';
    assert.equal(tokenUrl(url, null), url);
    assert.equal(tokenUrl(url, undefined), url);
    assert.equal(tokenUrl(url, ''), url);
  });

  it('returns original URL for non-GitHub URLs', () => {
    const url = 'https://gitlab.com/org/repo.git';
    assert.equal(tokenUrl(url, 'tok123'), url);
  });

  it('handles nested org/repo paths', () => {
    const result = tokenUrl('git@github.com:my-org/my-repo.git', 'tok');
    assert.equal(result, 'https://x-access-token:tok@github.com/my-org/my-repo.git');
  });
});
