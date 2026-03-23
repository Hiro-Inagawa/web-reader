const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

const originalFetch = global.fetch;
const originalExecSync = childProcess.execSync;

const {
  handlers, getDomain, loadDomainMemory, saveDomainMemory,
  tryDefuddle, fetchWithTimeout, cascade, MIN_CONTENT_LENGTH
} = require('./render');

// --- Mock helpers ---

function mockFetch(data) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data))
  });
}

function mockFetchByUrl(urlMap) {
  global.fetch = async (url) => {
    for (const [pattern, data] of Object.entries(urlMap)) {
      if (url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => data,
          text: async () => (typeof data === 'string' ? data : JSON.stringify(data))
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

function restore() {
  global.fetch = originalFetch;
  childProcess.execSync = originalExecSync;
}

// ============================================================
// getDomain
// ============================================================

describe('getDomain', () => {
  it('extracts domain from URL', () => {
    assert.equal(getDomain('https://reddit.com/r/test'), 'reddit.com');
  });

  it('strips www prefix', () => {
    assert.equal(getDomain('https://www.example.com/page'), 'example.com');
  });

  it('preserves subdomains other than www', () => {
    assert.equal(getDomain('https://old.reddit.com/r/test'), 'old.reddit.com');
  });

  it('returns null for invalid URL', () => {
    assert.equal(getDomain('not-a-url'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(getDomain(''), null);
  });

  it('handles URLs with ports', () => {
    assert.equal(getDomain('https://localhost:3000/path'), 'localhost');
  });
});

// ============================================================
// Handler matching
// ============================================================

describe('Reddit matching', () => {
  it('matches www.reddit.com', () => {
    assert.ok(handlers.reddit.match('https://www.reddit.com/r/ClaudeAI'));
  });

  it('matches old.reddit.com', () => {
    assert.ok(handlers.reddit.match('https://old.reddit.com/r/test'));
  });

  it('matches bare reddit.com', () => {
    assert.ok(handlers.reddit.match('https://reddit.com/r/test'));
  });

  it('rejects other domains', () => {
    assert.ok(!handlers.reddit.match('https://example.com'));
  });
});

describe('Hacker News matching', () => {
  it('matches item URLs', () => {
    assert.ok(handlers.hackernews.match('https://news.ycombinator.com/item?id=12345'));
  });

  it('matches newest page', () => {
    assert.ok(handlers.hackernews.match('https://news.ycombinator.com/newest'));
  });

  it('rejects homepage', () => {
    assert.ok(!handlers.hackernews.match('https://news.ycombinator.com/'));
  });
});

describe('Wikipedia matching', () => {
  it('matches English Wikipedia', () => {
    assert.ok(handlers.wikipedia.match('https://en.wikipedia.org/wiki/Node.js'));
  });

  it('matches other languages', () => {
    assert.ok(handlers.wikipedia.match('https://de.wikipedia.org/wiki/JavaScript'));
  });

  it('rejects non-wiki paths', () => {
    assert.ok(!handlers.wikipedia.match('https://en.wikipedia.org/about'));
  });
});

describe('GitHub matching', () => {
  it('matches repo URLs', () => {
    assert.ok(handlers.github.match('https://github.com/user/repo'));
  });

  it('matches issue URLs', () => {
    assert.ok(handlers.github.match('https://github.com/user/repo/issues/1'));
  });

  it('matches PR URLs', () => {
    assert.ok(handlers.github.match('https://github.com/user/repo/pull/42'));
  });

  it('rejects github.io', () => {
    assert.ok(!handlers.github.match('https://user.github.io/site'));
  });
});

// ============================================================
// Reddit handler fetch
// ============================================================

describe('Reddit handler fetch', () => {
  afterEach(restore);

  it('formats subreddit listing', async () => {
    mockFetch({
      data: {
        children: [
          { kind: 't3', data: { title: 'Test Post', author: 'testuser', score: 100, num_comments: 10, selftext: 'Post body' } },
          { kind: 't3', data: { title: 'Second Post', author: 'other', score: 50, num_comments: 3, selftext: '' } }
        ]
      }
    });

    const result = await handlers.reddit.fetch('https://www.reddit.com/r/test');
    assert.ok(result.includes('# Test Post'));
    assert.ok(result.includes('u/testuser'));
    assert.ok(result.includes('Score: 100'));
    assert.ok(result.includes('# Second Post'));
  });

  it('formats comment thread with nested replies', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => [
        { data: { children: [{ kind: 't3', data: { title: 'Thread', subreddit: 'test', author: 'op', score: 200, num_comments: 2, selftext: '' } }] } },
        { data: { children: [
          { kind: 't1', data: { author: 'commenter', score: 10, body: 'Great post', replies: {
            data: { children: [
              { kind: 't1', data: { author: 'replier', score: 5, body: 'Agreed', replies: '' } }
            ] }
          } } }
        ] } }
      ]
    });

    const result = await handlers.reddit.fetch('https://www.reddit.com/r/test/comments/abc/thread');
    assert.ok(result.includes('# Thread'));
    assert.ok(result.includes('u/commenter'));
    assert.ok(result.includes('Great post'));
    assert.ok(result.includes('u/replier'));
    assert.ok(result.includes('Agreed'));
  });

  it('throws on API error', async () => {
    global.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(
      () => handlers.reddit.fetch('https://www.reddit.com/r/test'),
      /Reddit API returned 403/
    );
  });
});

// ============================================================
// Hacker News handler fetch
// ============================================================

describe('HN handler fetch', () => {
  afterEach(restore);

  it('formats story with comments', async () => {
    mockFetchByUrl({
      '/item/123.json': { title: 'Test Story', by: 'poster', score: 100, descendants: 1, url: 'https://example.com', kids: [456] },
      '/item/456.json': { by: 'commenter', text: 'Nice article', kids: [] }
    });

    const result = await handlers.hackernews.fetch('https://news.ycombinator.com/item?id=123');
    assert.ok(result.includes('# Test Story'));
    assert.ok(result.includes('u/poster'));
    assert.ok(result.includes('Score: 100'));
    assert.ok(result.includes('Nice article'));
  });

  it('throws when no ID in URL', async () => {
    await assert.rejects(
      () => handlers.hackernews.fetch('https://news.ycombinator.com/newest'),
      /No HN item ID found/
    );
  });
});

// ============================================================
// Wikipedia handler fetch
// ============================================================

describe('Wikipedia handler fetch', () => {
  afterEach(restore);

  it('formats article', async () => {
    mockFetch({
      query: {
        pages: {
          '123': { title: 'Node.js', displaytitle: 'Node.js', extract: 'Node.js is a runtime environment.' }
        }
      }
    });

    const result = await handlers.wikipedia.fetch('https://en.wikipedia.org/wiki/Node.js');
    assert.ok(result.includes('# Node.js'));
    assert.ok(result.includes('runtime environment'));
  });

  it('throws on missing article', async () => {
    mockFetch({ query: { pages: { '-1': { missing: '' } } } });
    await assert.rejects(
      () => handlers.wikipedia.fetch('https://en.wikipedia.org/wiki/Nonexistent'),
      /Wikipedia article not found/
    );
  });
});

// ============================================================
// GitHub handler fetch
// ============================================================

describe('GitHub handler fetch', () => {
  afterEach(restore);

  it('formats repo root with README', async () => {
    mockFetchByUrl({
      'api.github.com/repos/user/repo/readme': '# My Project\nA cool tool.',
      'api.github.com/repos/user/repo': {
        full_name: 'user/repo', description: 'A cool tool',
        stargazers_count: 100, forks_count: 10, open_issues_count: 5,
        language: 'JavaScript', license: { spdx_id: 'MIT' },
        updated_at: '2026-01-01', topics: ['cli']
      }
    });

    const result = await handlers.github.fetch('https://github.com/user/repo');
    assert.ok(result.includes('# user/repo'));
    assert.ok(result.includes('Stars: 100'));
    assert.ok(result.includes('MIT'));
    assert.ok(result.includes('# My Project'));
  });

  it('formats issue with comments', async () => {
    mockFetchByUrl({
      '/issues/42/comments': [{ user: { login: 'reviewer' }, created_at: '2026-01-02', body: 'Looks good' }],
      '/issues/42': { title: 'Fix bug', state: 'open', user: { login: 'author' }, created_at: '2026-01-01', labels: [], body: 'Something is broken' }
    });

    const result = await handlers.github.fetch('https://github.com/user/repo/issues/42');
    assert.ok(result.includes('# Fix bug (#42)'));
    assert.ok(result.includes('State: open'));
    assert.ok(result.includes('Something is broken'));
    assert.ok(result.includes('reviewer'));
    assert.ok(result.includes('Looks good'));
  });

  it('returns null for discussion URLs', async () => {
    mockFetch({});
    const result = await handlers.github.fetch('https://github.com/user/repo/discussions/1');
    assert.equal(result, null);
  });

  it('returns null for blob URLs', async () => {
    mockFetch({});
    const result = await handlers.github.fetch('https://github.com/user/repo/blob/main/file.js');
    assert.equal(result, null);
  });
});

// ============================================================
// Domain Memory
// ============================================================

describe('Domain Memory', () => {
  let tmpDir, tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-test-'));
    tmpFile = path.join(tmpDir, 'domains.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('returns empty object when file does not exist', () => {
    assert.deepEqual(loadDomainMemory(tmpFile), {});
  });

  it('saves and loads roundtrip', () => {
    const data = { 'example.com': 'defuddle', 'reddit.com': 'handler:reddit' };
    saveDomainMemory(data, tmpFile);
    assert.deepEqual(loadDomainMemory(tmpFile), data);
  });

  it('overwrites previous data', () => {
    saveDomainMemory({ 'old.com': 'browser' }, tmpFile);
    saveDomainMemory({ 'new.com': 'defuddle' }, tmpFile);
    assert.deepEqual(loadDomainMemory(tmpFile), { 'new.com': 'defuddle' });
  });

  it('leaves no temp files behind', () => {
    saveDomainMemory({ 'test.com': 'browser' }, tmpFile);
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'domains.json');
  });
});

// ============================================================
// tryDefuddle
// ============================================================

describe('tryDefuddle', () => {
  afterEach(restore);

  it('returns content when defuddle succeeds', () => {
    childProcess.execSync = () => 'This is extracted markdown content that is definitely longer than fifty characters to pass the validation check.';
    const result = tryDefuddle('https://example.com');
    assert.ok(result);
    assert.ok(result.length > MIN_CONTENT_LENGTH);
  });

  it('returns null when content is too short', () => {
    childProcess.execSync = () => 'Short';
    assert.equal(tryDefuddle('https://example.com'), null);
  });

  it('returns null when defuddle throws', () => {
    childProcess.execSync = () => { throw new Error('command not found'); };
    assert.equal(tryDefuddle('https://example.com'), null);
  });

  it('returns null for whitespace-only output', () => {
    childProcess.execSync = () => '   \n  \n  ';
    assert.equal(tryDefuddle('https://example.com'), null);
  });
});

// ============================================================
// fetchWithTimeout
// ============================================================

describe('fetchWithTimeout', () => {
  afterEach(restore);

  it('returns response on success', async () => {
    global.fetch = async () => ({ ok: true, status: 200 });
    const res = await fetchWithTimeout('https://example.com');
    assert.equal(res.ok, true);
  });

  it('aborts on timeout', async () => {
    global.fetch = async (url, opts) => {
      return new Promise((_, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort);
      });
    };
    await assert.rejects(
      () => fetchWithTimeout('https://example.com', {}, 50),
      /aborted/
    );
  });
});

// ============================================================
// Cascade logic
// ============================================================

describe('Cascade', () => {
  let tmpDir, tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-test-'));
    tmpFile = path.join(tmpDir, 'domains.json');
  });

  afterEach(() => {
    restore();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('uses handler when URL matches', async () => {
    mockFetch({
      data: { children: [{ kind: 't3', data: { title: 'Post', author: 'u', score: 1, num_comments: 0, selftext: '' } }] }
    });

    const { result, method } = await cascade('https://www.reddit.com/r/test', { domainsFile: tmpFile });
    assert.ok(result);
    assert.equal(method, 'handler:reddit');
  });

  it('saves method to domain memory', async () => {
    mockFetch({
      data: { children: [{ kind: 't3', data: { title: 'Post', author: 'u', score: 1, num_comments: 0, selftext: '' } }] }
    });

    await cascade('https://www.reddit.com/r/test', { domainsFile: tmpFile });
    const memory = loadDomainMemory(tmpFile);
    assert.equal(memory['reddit.com'], 'handler:reddit');
  });

  it('uses remembered method on second call', async () => {
    saveDomainMemory({ 'reddit.com': 'handler:reddit' }, tmpFile);
    mockFetch({
      data: { children: [{ kind: 't3', data: { title: 'Post', author: 'u', score: 1, num_comments: 0, selftext: '' } }] }
    });

    const { method } = await cascade('https://www.reddit.com/r/test', { domainsFile: tmpFile });
    assert.equal(method, 'handler:reddit');
  });

  it('falls through to defuddle when no handler matches', async () => {
    childProcess.execSync = () => 'This is clean extracted content from defuddle that is longer than the minimum content length threshold easily.';

    const { result, method } = await cascade('https://docs.example.com/page', { domainsFile: tmpFile });
    assert.ok(result);
    assert.equal(method, 'defuddle');
  });

  it('forced method skips cascade', async () => {
    childProcess.execSync = () => 'Forced defuddle content that exceeds the minimum content length of fifty characters for the validation.';

    const { method } = await cascade('https://www.reddit.com/r/test', {
      forceMethod: 'defuddle',
      domainsFile: tmpFile
    });
    assert.equal(method, 'defuddle');
  });
});

// ============================================================
// CLI integration
// ============================================================

describe('CLI', () => {
  const renderPath = path.join(__dirname, 'render.js');

  it('exits with error on invalid URL', () => {
    try {
      originalExecSync('node ' + JSON.stringify(renderPath) + ' "not-a-url"', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      assert.fail('Should have exited with error');
    } catch (e) {
      assert.ok(e.stderr.includes('Invalid URL'));
    }
  });

  it('exits with usage on no arguments', () => {
    try {
      originalExecSync('node ' + JSON.stringify(renderPath), {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      assert.fail('Should have exited with error');
    } catch (e) {
      assert.ok(e.stderr.includes('Usage:'));
    }
  });
});
