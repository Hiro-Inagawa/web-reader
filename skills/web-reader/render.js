#!/usr/bin/env node

const { execSync } = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));

if (!url) {
  console.error('Usage: node render.js <url> [--wait ms] [--screenshot] [--html] [--method defuddle|browser|handler]');
  process.exit(1);
}

// Validate URL before doing anything
try { new URL(url); } catch {
  console.error('Error: Invalid URL: ' + url);
  process.exit(1);
}

const waitTime = parseInt(args[args.indexOf('--wait') + 1]) || 3000;
const takeScreenshot = args.includes('--screenshot');
const outputHtml = args.includes('--html');
const forceMethod = args.includes('--method')
  ? args[args.indexOf('--method') + 1]
  : null;

const API_TIMEOUT = 15000;
const MIN_CONTENT_LENGTH = 50;

// --- Domain Memory (atomic writes to prevent race conditions) ---
const domainsPath = path.join(__dirname, 'domains.json');

function loadDomainMemory() {
  try {
    return JSON.parse(fs.readFileSync(domainsPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveDomainMemory(memory) {
  const tmpPath = domainsPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(memory, null, 2));
    fs.renameSync(tmpPath, domainsPath);
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
            // Fetch nested replies in parallel (max 5)
            if (c.kids) {
              await Promise.all(c.kids.slice(0, 5).map(kid => fetchComment(kid, depth + 1)));
            }
          } catch {}
        };
        // Fetch top-level comments in parallel batches of 5
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

      // Get full text directly via TextExtracts API (single call)
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

      // Check for issue/PR URLs
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

        // Fetch comments
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

      // Check for discussion URLs (fall through to browser)
      if (url.match(/\/discussions\//)) return null;

      // Check for file/tree URLs (fall through to browser)
      if (url.match(/\/(blob|tree)\//)) return null;

      // Repo root
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

      // Try to get README
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
    // JSON.stringify properly escapes the URL for shell safety
    const md = execSync('defuddle parse ' + JSON.stringify(url) + ' --md', {
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

async function fetchWithBrowser(url) {
  const { browser, context } = await launchStealth();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(waitTime);

    if (takeScreenshot) {
      const screenshotPath = path.join(os.tmpdir(), 'web-reader-screenshot.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error('Screenshot saved to ' + screenshotPath);
    }

    if (outputHtml) {
      return await page.content();
    }

    const text = await page.evaluate(() => document.body.innerText);

    // Validate that we got meaningful content
    if (!text || text.trim().length < MIN_CONTENT_LENGTH) {
      return null;
    }
    return text;
  } finally {
    await browser.close();
  }
}

// --- Main Cascade ---
(async () => {
  const domain = getDomain(url);
  const memory = loadDomainMemory();
  const remembered = domain ? memory[domain] : null;

  let result = null;
  let method = null;

  // If forced method, use it directly
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
      result = await fetchWithBrowser(url);
      if (!result) throw new Error('Browser returned no content');
      method = 'browser';
    }
  }
  // If we remember what works for this domain, try that first
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
      } else if (remembered === 'browser') {
        result = await fetchWithBrowser(url);
        if (result) method = 'browser';
      }
    } catch (e) {
      console.error('[web-reader] Remembered method threw: ' + e.message);
    }

    if (!result) {
      console.error('[web-reader] Remembered method failed, trying full cascade');
    }
  }

  // Full cascade: handler -> defuddle -> browser
  if (!result) {
    // 1. Site-specific handlers
    if (!takeScreenshot && !outputHtml) {
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

    // 2. Defuddle (fast, no browser)
    if (!result && !takeScreenshot && !outputHtml) {
      console.error('[web-reader] Trying defuddle...');
      result = tryDefuddle(url);
      if (result) method = 'defuddle';
    }

    // 3. Stealth browser (handles everything else)
    if (!result) {
      console.error('[web-reader] Trying stealth browser...');
      result = await fetchWithBrowser(url);
      if (result) method = 'browser';
    }
  }

  if (result) {
    console.log(result);

    // Save to domain memory
    if (domain && method) {
      memory[domain] = method;
      saveDomainMemory(memory);
    }
  } else {
    console.error('[web-reader] All methods failed for ' + url);
    process.exit(1);
  }
})().catch(e => {
  console.error('Error: ' + e.message);
  process.exit(1);
});
