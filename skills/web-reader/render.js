#!/usr/bin/env node

const childProcess = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { extractCookies } = require('./cookies.js');

const API_TIMEOUT = 15000;
const MIN_CONTENT_LENGTH = 50;

// --- Domain Memory (atomic writes to prevent race conditions) ---
const domainsPath = path.join(__dirname, 'domains.json');

function loadDomainMemory(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath || domainsPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveDomainMemory(memory, filePath) {
  const target = filePath || domainsPath;
  const tmpPath = target + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(memory, null, 2));
    fs.renameSync(tmpPath, target);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// --- Fetch with timeout ---
async function fetchWithTimeout(url, options = {}, timeout = API_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// --- Site-Specific Handlers ---
const handlers = {
  reddit: {
    match: (url) => /^https?:\/\/(www\.|old\.)?reddit\.com\//i.test(url),
    fetch: async (url) => {
      const jsonUrl = url.replace(/\/?(\?.*)?$/, '.json$1');
      const separator = jsonUrl.includes('?') ? '&' : '?';
      const res = await fetchWithTimeout(jsonUrl + separator + 'limit=50', {
        headers: { 'User-Agent': 'web-reader/1.0 (github.com/Hiro-Inagawa/web-reader)' }
      });
      if (!res.ok) throw new Error('Reddit API returned ' + res.status);
      const data = await res.json();

      const lines = [];
      if (!url.includes('/comments/')) {
        const posts = data.data?.children || [];
        posts.forEach(p => {
          if (p.kind !== 't3') return;
          const d = p.data;
          lines.push('# ' + d.title);
          lines.push('u/' + d.author + ' | Score: ' + d.score + ' | Comments: ' + d.num_comments);
          if (d.selftext) lines.push(d.selftext);
          lines.push('');
        });
        return lines.join('\n');
      }

      const post = data[0].data.children[0].data;
      lines.push('# ' + post.title);
      lines.push('r/' + post.subreddit + ' | u/' + post.author + ' | Score: ' + post.score + ' | Comments: ' + post.num_comments);
      if (post.selftext) lines.push('\n' + post.selftext);
      lines.push('');

      const flatten = (children, depth) => {
        for (const c of children) {
          if (c.kind !== 't1') continue;
          const d = c.data;
          const indent = '  '.repeat(depth);
          lines.push('---');
          lines.push(indent + 'u/' + d.author + ' | Score: ' + d.score);
          lines.push(indent + d.body);
          lines.push('');
          if (d.replies && d.replies.data) {
            flatten(d.replies.data.children, depth + 1);
          }
        }
      };
      flatten(data[1].data.children, 0);
      return lines.join('\n');
    }
  },

  hackernews: {
    match: (url) => /^https?:\/\/news\.ycombinator\.com\/(item|newest|ask|show)/i.test(url),
    fetch: async (url) => {
      const idMatch = url.match(/id=(\d+)/);
      if (!idMatch) throw new Error('No HN item ID found in URL');
      const id = idMatch[1];
      const res = await fetchWithTimeout('https://hacker-news.firebaseio.com/v0/item/' + id + '.json');
      const item = await res.json();

      const lines = [];
      lines.push('# ' + (item.title || 'Comment'));
      lines.push('u/' + item.by + ' | Score: ' + (item.score || 0) + ' | Comments: ' + (item.descendants || 0));
      if (item.url) lines.push('Link: ' + item.url);
      if (item.text) lines.push('\n' + item.text);
      lines.push('');

      if (item.kids && item.kids.length > 0) {
        const fetchComment = async (id, depth) => {
          try {
            const r = await fetchWithTimeout('https://hacker-news.firebaseio.com/v0/item/' + id + '.json');
            const c = await r.json();
            if (!c || c.deleted || c.dead) return;
            const indent = '  '.repeat(depth);
            lines.push('---');
            lines.push(indent + 'u/' + c.by);
            lines.push(indent + (c.text || '').replace(/<[^>]+>/g, ''));
            lines.push('');
            if (c.kids) {
              await Promise.all(c.kids.slice(0, 5).map(kid => fetchComment(kid, depth + 1)));
            }
          } catch {}
        };
        const topKids = item.kids.slice(0, 20);
        for (let i = 0; i < topKids.length; i += 5) {
          await Promise.all(topKids.slice(i, i + 5).map(kid => fetchComment(kid, 0)));
        }
      }
      return lines.join('\n');
    }
  },

  wikipedia: {
    match: (url) => /^https?:\/\/\w+\.wikipedia\.org\/wiki\//i.test(url),
    fetch: async (url) => {
      const urlObj = new URL(url);
      const lang = urlObj.hostname.split('.')[0];
      const title = decodeURIComponent(urlObj.pathname.replace('/wiki/', ''));

      const fullUrl = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&titles=' +
        encodeURIComponent(title) + '&prop=extracts|info&explaintext=1&format=json&inprop=displaytitle';
      const res = await fetchWithTimeout(fullUrl, {
        headers: { 'User-Agent': 'web-reader/1.0 (github.com/Hiro-Inagawa/web-reader)' }
      });
      if (!res.ok) throw new Error('Wikipedia API returned ' + res.status);
      const data = await res.json();
      const pages = data.query?.pages || {};
      const page = Object.values(pages)[0];
      if (!page || page.missing !== undefined) throw new Error('Wikipedia article not found');

      const lines = [];
      lines.push('# ' + (page.displaytitle || page.title || title));
      lines.push('');
      lines.push(page.extract || '');
      return lines.join('\n');
    }
  },

  github: {
    match: (url) => /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/.*)?$/i.test(url),
    fetch: async (url) => {
      const repoMatch = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
      if (!repoMatch) throw new Error('Could not parse GitHub URL');
      const [, owner, repo] = repoMatch;
      const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo;
      const headers = { 'User-Agent': 'web-reader/1.0' };

      const issueMatch = url.match(/\/(issues|pull)\/(\d+)/);
      if (issueMatch) {
        const [, type, number] = issueMatch;
        const endpoint = type === 'pull' ? '/pulls/' : '/issues/';
        const res = await fetchWithTimeout(apiBase + endpoint + number, { headers });
        if (!res.ok) throw new Error('GitHub API returned ' + res.status);
        const item = await res.json();

        const lines = [];
        lines.push('# ' + item.title + ' (#' + number + ')');
        lines.push('State: ' + item.state + ' | Author: ' + item.user.login + ' | Created: ' + item.created_at);
        if (item.labels?.length) lines.push('Labels: ' + item.labels.map(l => l.name).join(', '));
        lines.push('');
        if (item.body) lines.push(item.body);

        const commentsRes = await fetchWithTimeout(apiBase + '/issues/' + number + '/comments?per_page=30', { headers });
        if (commentsRes.ok) {
          const comments = await commentsRes.json();
          for (const c of comments) {
            lines.push('');
            lines.push('---');
            lines.push('**' + c.user.login + '** (' + c.created_at + ')');
            lines.push(c.body);
          }
        }
        return lines.join('\n');
      }

      if (url.match(/\/discussions\//)) return null;
      if (url.match(/\/(blob|tree)\//)) return null;

      const res = await fetchWithTimeout(apiBase, { headers });
      if (!res.ok) throw new Error('GitHub API returned ' + res.status);
      const data = await res.json();

      const lines = [];
      lines.push('# ' + data.full_name);
      if (data.description) lines.push(data.description);
      lines.push('');
      lines.push('Stars: ' + data.stargazers_count + ' | Forks: ' + data.forks_count + ' | Open Issues: ' + data.open_issues_count);
      lines.push('Language: ' + (data.language || 'N/A'));
      lines.push('License: ' + (data.license?.spdx_id || 'N/A'));
      lines.push('Last updated: ' + data.updated_at);
      if (data.topics?.length) lines.push('Topics: ' + data.topics.join(', '));
      lines.push('');

      const readmeRes = await fetchWithTimeout(apiBase + '/readme', {
        headers: { ...headers, 'Accept': 'application/vnd.github.raw+json' }
      });
      if (readmeRes.ok) {
        const readme = await readmeRes.text();
        lines.push('---');
        lines.push(readme);
      }
      return lines.join('\n');
    }
  }
};

// --- Defuddle Layer (single fetch, safe URL escaping) ---
function tryDefuddle(url) {
  try {
    const md = childProcess.execSync('defuddle parse ' + JSON.stringify(url) + ' --md', {
      timeout: 20000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const trimmed = md.trim();
    if (trimmed.length > MIN_CONTENT_LENGTH) return trimmed;
    return null;
  } catch {
    return null;
  }
}

// --- Stealth Browser Layer ---
async function launchStealth() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ignoreHTTPSErrors: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  return { browser, context };
}

async function fetchWithBrowser(url, opts = {}) {
  const { waitTime = 3000, screenshot = false, html = false, cookies = null } = opts;
  const { browser, context } = await launchStealth();

  // Inject cookies before navigation (authenticated access)
  if (cookies && cookies.length > 0) {
    try {
      await context.addCookies(cookies);
      console.error('[web-reader] Injected ' + cookies.length + ' cookies');
    } catch (e) {
      console.error('[web-reader] Cookie injection warning: ' + e.message);
    }
  }
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(waitTime);

    if (screenshot) {
      const screenshotPath = path.join(os.tmpdir(), 'web-reader-screenshot.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error('Screenshot saved to ' + screenshotPath);
    }

    if (html) {
      return await page.content();
    }

    const text = await page.evaluate(() => document.body.innerText);

    if (!text || text.trim().length < MIN_CONTENT_LENGTH) {
      return null;
    }
    return text;
  } finally {
    await browser.close();
  }
}

// --- Main Cascade ---
async function cascade(url, opts = {}) {
  const {
    forceMethod = null,
    screenshot = false,
    html = false,
    waitTime = 3000,
    domainsFile = domainsPath,
    cookies = null,
    cookiesFrom = null,
  } = opts;

  const domain = getDomain(url);
  const memory = loadDomainMemory(domainsFile);
  const remembered = domain ? memory[domain] : null;

  // Extract cookies from browser if requested
  let resolvedCookies = cookies;
  if (!resolvedCookies && cookiesFrom) {
    resolvedCookies = await extractCookies(cookiesFrom, domain);
  }

  const browserOpts = { waitTime, screenshot, html, cookies: resolvedCookies };
  const hasAuth = resolvedCookies && resolvedCookies.length > 0;

  if (hasAuth) {
    console.error('[web-reader] Authenticated mode: using browser with ' + resolvedCookies.length + ' cookies');
  }

  let result = null;
  let method = null;

  if (forceMethod) {
    if (forceMethod === 'handler') {
      for (const [name, handler] of Object.entries(handlers)) {
        if (handler.match(url)) {
          result = await handler.fetch(url);
          method = 'handler:' + name;
          break;
        }
      }
      if (!result) throw new Error('No handler matches this URL');
    } else if (forceMethod === 'defuddle') {
      result = tryDefuddle(url);
      if (!result) throw new Error('Defuddle returned no content');
      method = 'defuddle';
    } else if (forceMethod === 'browser') {
      result = await fetchWithBrowser(url, browserOpts);
      if (!result) throw new Error('Browser returned no content');
      method = 'browser';
    }
  }
  else if (remembered) {
    console.error('[web-reader] Using remembered method for ' + domain + ': ' + remembered);

    try {
      if (remembered.startsWith('handler:')) {
        const handlerName = remembered.split(':')[1];
        if (handlers[handlerName]?.match(url)) {
          result = await handlers[handlerName].fetch(url);
          method = remembered;
        }
      } else if (remembered === 'defuddle') {
        result = tryDefuddle(url);
        if (result) method = 'defuddle';
      } else if (remembered === 'browser' || remembered === 'browser:authenticated') {
        if (remembered === 'browser:authenticated' && !hasAuth) {
          console.error('[web-reader] Remembered as authenticated but no cookies provided, trying full cascade');
        } else {
          result = await fetchWithBrowser(url, browserOpts);
          if (result) method = hasAuth ? 'browser:authenticated' : 'browser';
        }
      }
    } catch (e) {
      console.error('[web-reader] Remembered method threw: ' + e.message);
    }

    if (!result) {
      console.error('[web-reader] Remembered method failed, trying full cascade');
    }
  }

  if (!result) {
    // When authenticated (cookies provided), skip handlers and defuddle.
    // Cookies only work in the browser layer.
    if (!hasAuth) {
      if (!screenshot && !html) {
        for (const [name, handler] of Object.entries(handlers)) {
          if (handler.match(url)) {
            try {
              result = await handler.fetch(url);
              if (result) method = 'handler:' + name;
            } catch (e) {
              console.error('[web-reader] Handler ' + name + ' failed: ' + e.message);
            }
            break;
          }
        }
      }

      if (!result && !screenshot && !html) {
        console.error('[web-reader] Trying defuddle...');
        result = tryDefuddle(url);
        if (result) method = 'defuddle';
      }
    }

    if (!result) {
      console.error('[web-reader] Trying stealth browser' + (hasAuth ? ' (authenticated)' : '') + '...');
      result = await fetchWithBrowser(url, browserOpts);
      if (result) method = hasAuth ? 'browser:authenticated' : 'browser';
    }
  }

  if (result && domain && method) {
    memory[domain] = method;
    saveDomainMemory(memory, domainsFile);
  }

  return { result, method };
}

// --- Exports for testing ---
module.exports = {
  handlers, tryDefuddle, fetchWithBrowser, launchStealth,
  fetchWithTimeout, loadDomainMemory, saveDomainMemory,
  getDomain, cascade,
  API_TIMEOUT, MIN_CONTENT_LENGTH, domainsPath
};

// --- CLI Entry Point ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));

  if (!url) {
    console.error('Usage: node render.js <url> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --wait <ms>              Wait time for browser rendering (default: 3000)');
    console.error('  --screenshot             Take a full-page screenshot');
    console.error('  --html                   Return raw HTML instead of text');
    console.error('  --method <method>        Force: defuddle, browser, or handler');
    console.error('  --cookies-from <browser> Use cookies from: chrome, edge, brave, firefox');
    console.error('  --cookies <file>         Use cookies from a Netscape cookie file');
    process.exit(1);
  }

  try { new URL(url); } catch {
    console.error('Error: Invalid URL: ' + url);
    process.exit(1);
  }

  const waitTime = parseInt(args[args.indexOf('--wait') + 1]) || 3000;
  const screenshot = args.includes('--screenshot');
  const html = args.includes('--html');
  const forceMethod = args.includes('--method')
    ? args[args.indexOf('--method') + 1]
    : null;
  const cookiesFrom = args.includes('--cookies-from')
    ? args[args.indexOf('--cookies-from') + 1]
    : null;
  const cookiesFile = args.includes('--cookies')
    ? args[args.indexOf('--cookies') + 1]
    : null;

  cascade(url, {
    forceMethod,
    screenshot,
    html,
    waitTime,
    cookiesFrom: cookiesFrom || cookiesFile,
  })
    .then(({ result }) => {
      if (result) {
        console.log(result);
      } else {
        console.error('[web-reader] All methods failed for ' + url);
        process.exit(1);
      }
    })
    .catch(e => {
      console.error('Error: ' + e.message);
      process.exit(1);
    });
}
