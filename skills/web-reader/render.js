#!/usr/bin/env node

const { chromium } = require('playwright');

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));

if (!url) {
  console.error('Usage: node render.js <url> [--wait ms] [--screenshot] [--html]');
  process.exit(1);
}

const waitTime = parseInt(args[args.indexOf('--wait') + 1]) || 3000;
const takeScreenshot = args.includes('--screenshot');
const outputHtml = args.includes('--html');

// Site-specific handlers for sites that block headless browsers
const handlers = {
  reddit: {
    match: (url) => /^https?:\/\/(www\.|old\.)?reddit\.com\//i.test(url),
    fetch: async (url) => {
      const jsonUrl = url.replace(/\/?(\?.*)?$/, '.json$1');
      const separator = jsonUrl.includes('?') ? '&' : '?';
      const res = await fetch(jsonUrl + separator + 'limit=50', {
        headers: { 'User-Agent': 'web-reader/1.0 (github.com/Hiro-Inagawa/web-reader)' }
      });
      if (!res.ok) throw new Error('Reddit API returned ' + res.status);
      const data = await res.json();

      const lines = [];
      // Subreddit listing (e.g. reddit.com/r/AskReddit)
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

      // Thread with comments
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
  }
};

// Stealth browser launch to bypass Cloudflare and common bot detection
async function launchStealth() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Fake plugins array
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    // Remove headless indicators from Chrome runtime
    window.chrome = { runtime: {} };
  });

  return { browser, context };
}

(async () => {
  // Try site-specific handler first
  for (const handler of Object.values(handlers)) {
    if (handler.match(url) && !outputHtml && !takeScreenshot) {
      const text = await handler.fetch(url);
      console.log(text);
      return;
    }
  }

  // Stealth browser for everything else
  const { browser, context } = await launchStealth();
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(waitTime);

  if (takeScreenshot) {
    const path = '/tmp/web-reader-screenshot.png';
    await page.screenshot({ path, fullPage: true });
    console.error('Screenshot saved to ' + path);
  }

  if (outputHtml) {
    const html = await page.content();
    console.log(html);
  } else {
    const text = await page.evaluate(() => document.body.innerText);
    console.log(text);
  }

  await browser.close();
})().catch(e => {
  console.error('Error: ' + e.message);
  process.exit(1);
});
