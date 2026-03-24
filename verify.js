#!/usr/bin/env node

/**
 * Manual verification script for Web Reader.
 *
 * Tests real websites to confirm the cascade engine works.
 * NOT for CI — these hit live sites and can be flaky due to
 * network conditions, rate limits, or site changes.
 *
 * Usage:
 *   node verify.js              # Run all checks
 *   node verify.js --quick      # Skip slow browser tests
 *   node verify.js reddit       # Run one specific check
 */

const { cascade, handlers, tryDefuddle, fetchWithBrowser } = require('./skills/web-reader/render.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHECKS = [
  {
    name: 'Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Turing_machine',
    layer: 'handler',
    expect: (text) => text.includes('Turing') && text.length > 500,
  },
  {
    name: 'GitHub repo',
    url: 'https://github.com/anthropics/claude-code',
    layer: 'handler',
    expect: (text) => text.includes('claude') || text.includes('Claude') || text.includes('anthropic'),
  },
  {
    name: 'GitHub issue',
    url: 'https://github.com/anthropics/claude-code/issues/1',
    layer: 'handler',
    expect: (text) => text.includes('#1') && text.length > 100,
  },
  {
    name: 'Reddit subreddit',
    url: 'https://www.reddit.com/r/programming/',
    layer: 'handler',
    expect: (text) => text.includes('Score:') && text.length > 200,
  },
  {
    name: 'Reddit post',
    url: 'https://www.reddit.com/r/programming/top/.json?limit=1',
    layer: 'handler',
    expect: (text) => text.length > 100,
    transform: (url) => 'https://www.reddit.com/r/programming/top/?limit=1',
  },
  {
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/item?id=1',
    layer: 'handler',
    expect: (text) => text.includes('Y Combinator') || text.includes('Score:'),
  },
  {
    name: 'Defuddle (docs)',
    url: 'https://docs.github.com/en/get-started',
    layer: 'defuddle',
    expect: (text) => text && text.length > 200,
    slow: false,
  },
  {
    name: 'SPA (coachsensai.com)',
    url: 'https://www.coachsensai.com/',
    layer: 'browser',
    expect: (text) => text && text.length > 200,
    slow: true,
  },
  {
    name: 'LinkedIn job posting',
    url: 'https://www.linkedin.com/jobs/view/4196024795',
    layer: 'browser',
    expect: (text) => text && text.length > 200,
    slow: true,
  },
  {
    name: 'Crates.io (SPA)',
    url: 'https://crates.io/crates/serde',
    layer: 'browser',
    expect: (text) => text && (text.includes('serde') || text.includes('Serde')) && text.length > 200,
    slow: true,
  },
];

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function formatTime(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

async function runCheck(check) {
  const url = check.transform ? check.transform(check.url) : check.url;
  const start = Date.now();

  // Use a temp domains file so verification doesn't pollute the real one
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-verify-'));
  const tmpDomains = path.join(tmpDir, 'domains.json');

  try {
    const { result, method } = await cascade(url, { domainsFile: tmpDomains });
    const elapsed = Date.now() - start;

    if (!result) {
      return { pass: false, time: elapsed, error: 'No content returned', method: null };
    }

    const valid = check.expect(result);
    if (!valid) {
      return {
        pass: false,
        time: elapsed,
        error: 'Content did not match expectations (' + result.length + ' chars)',
        method,
      };
    }

    return { pass: true, time: elapsed, method, chars: result.length };
  } catch (e) {
    return { pass: false, time: Date.now() - start, error: e.message, method: null };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const filter = args.find(a => !a.startsWith('--'));

  let checks = CHECKS;
  if (filter) {
    checks = CHECKS.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()));
    if (checks.length === 0) {
      console.error('No checks match "' + filter + '". Available:');
      CHECKS.forEach(c => console.error('  ' + c.name));
      process.exit(1);
    }
  }
  if (quick) {
    checks = checks.filter(c => !c.slow);
  }

  console.log('');
  console.log(COLORS.bold + 'Web Reader Verification' + COLORS.reset);
  console.log(COLORS.dim + 'Testing ' + checks.length + ' sites against live endpoints' + COLORS.reset);
  console.log('');

  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    process.stdout.write('  ' + check.name.padEnd(28) + COLORS.dim + check.layer.padEnd(10) + COLORS.reset);

    const result = await runCheck(check);

    if (result.pass) {
      passed++;
      console.log(
        COLORS.green + 'PASS' + COLORS.reset +
        COLORS.dim + '  ' + formatTime(result.time).padStart(6) +
        '  ' + result.method +
        '  (' + result.chars + ' chars)' + COLORS.reset
      );
    } else {
      failed++;
      console.log(
        COLORS.red + 'FAIL' + COLORS.reset +
        COLORS.dim + '  ' + formatTime(result.time).padStart(6) +
        '  ' + result.error + COLORS.reset
      );
    }
  }

  console.log('');
  console.log(
    COLORS.bold +
    passed + ' passed' +
    (failed > 0 ? ', ' + COLORS.red + failed + ' failed' + COLORS.reset : '') +
    COLORS.reset +
    COLORS.dim + ' out of ' + checks.length + ' checks' + COLORS.reset
  );
  console.log('');

  if (failed > 0) {
    console.log(COLORS.yellow + 'Note: Failures may be caused by network conditions, rate limits,' + COLORS.reset);
    console.log(COLORS.yellow + 'or site changes. Re-run individual checks to confirm.' + COLORS.reset);
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
