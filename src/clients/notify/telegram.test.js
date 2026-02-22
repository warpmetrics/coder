import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { githubToTelegramHtml, escapeHtml } from './telegram.js';

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  });

  it('handles empty string', () => {
    assert.equal(escapeHtml(''), '');
  });

  it('handles already-safe text', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });
});

describe('githubToTelegramHtml', () => {
  it('converts bold markdown', () => {
    const result = githubToTelegramHtml('hello **world**');
    assert.ok(result.includes('<b>world</b>'));
  });

  it('converts inline code', () => {
    const result = githubToTelegramHtml('use `foo()` here');
    assert.ok(result.includes('<code>foo()</code>'));
  });

  it('escapes HTML inside inline code', () => {
    const result = githubToTelegramHtml('use `a<b>c` here');
    assert.ok(result.includes('<code>a&lt;b&gt;c</code>'));
  });

  it('converts fenced code blocks', () => {
    const result = githubToTelegramHtml('```js\nconst x = 1;\n```');
    assert.ok(result.includes('<pre>const x = 1;</pre>'));
  });

  it('escapes HTML inside code blocks', () => {
    const result = githubToTelegramHtml('```\na < b && c > d\n```');
    assert.ok(result.includes('&lt;'));
    assert.ok(result.includes('&amp;'));
  });

  it('converts markdown links', () => {
    const result = githubToTelegramHtml('[click](https://example.com)');
    assert.ok(result.includes('<a href="https://example.com">click</a>'));
  });

  it('strips HTML comments', () => {
    const result = githubToTelegramHtml('hello <!-- secret --> world');
    assert.ok(!result.includes('secret'));
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('world'));
  });

  it('strips details/summary tags', () => {
    const result = githubToTelegramHtml('<details><summary>Title</summary>Content</details>');
    assert.ok(result.includes('Title'));
    assert.ok(result.includes('Content'));
    assert.ok(!result.includes('<details>'));
  });

  it('truncates long messages', () => {
    const long = 'x'.repeat(5000);
    const result = githubToTelegramHtml(long);
    assert.ok(result.length <= 4096);
    assert.ok(result.includes('(truncated)'));
  });

  it('handles empty string', () => {
    const result = githubToTelegramHtml('');
    assert.equal(result, '');
  });

  it('handles plain text without markdown', () => {
    const result = githubToTelegramHtml('just plain text');
    assert.ok(result.includes('just plain text'));
  });
});
