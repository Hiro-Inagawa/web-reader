# Web Reader

Read any URL and get its content back as text. Automatically picks the fastest method that works: site-specific APIs, lightweight extraction (Defuddle), or stealth headless browser. Learns which method works for each domain and remembers it across sessions.

**This replaces both `/defuddle` and the old `/web-reader`.** One skill, one command, all websites.

## When to Use

- User shares any URL and wants its content
- `WebFetch` returns only a page title, "requires JavaScript", or garbage
- User asks to "look at", "read", or "check" a website
- URL is Reddit, Hacker News, Wikipedia, or GitHub
- Site uses Cloudflare or other bot detection
- Scanning many URLs (domain memory speeds up repeated access)

## Usage

```bash
node <skill-directory>/render.js "https://example.com"
```

The script automatically cascades through methods until one works:

1. **Site handlers** (Reddit, HN, Wikipedia, GitHub) via their APIs
2. **Defuddle** for server-rendered pages (fast, no browser)
3. **Stealth browser** for SPAs and bot-protected sites

On success, it remembers which method worked for that domain in `domains.json`. Next time the same domain is requested, it skips straight to the working method.

## Options

```bash
# Custom wait time for browser (milliseconds, default: 3000)
node <skill-directory>/render.js "https://example.com" --wait 5000

# Take a screenshot (forces browser method)
node <skill-directory>/render.js "https://example.com" --screenshot

# Get raw HTML instead of text (forces browser method)
node <skill-directory>/render.js "https://example.com" --html

# Force a specific method (skip cascade)
node <skill-directory>/render.js "https://example.com" --method defuddle
node <skill-directory>/render.js "https://example.com" --method browser
node <skill-directory>/render.js "https://example.com" --method handler

# Batch: pass multiple URLs. One browser is pooled across the whole batch
# (the expensive part), fetched concurrently, printed in input order.
node <skill-directory>/render.js "https://a.com" "https://b.com" "https://c.com" --concurrency 4

# Wait for a selector before extracting (faster + more reliable than a fixed wait)
node <skill-directory>/render.js "https://example.com" --wait-for "main article"

# Route the browser layer through a proxy
node <skill-directory>/render.js "https://example.com" --method browser --proxy "http://host:8080"

# Cache control (cache is ON by default, 15-minute TTL)
node <skill-directory>/render.js "https://example.com" --no-cache        # always fresh
node <skill-directory>/render.js "https://example.com" --cache-ttl 60    # 60-minute TTL
```

## Response cache

Successful fetches are cached on disk (in `.cache/` next to `domains.json`), so
re-reading the same URL within the TTL returns instantly instead of re-rendering.
On by default with a 15-minute TTL. Bypass with `--no-cache`, tune with
`--cache-ttl <minutes>`. Authenticated (`--cookies-from`) and screenshot fetches
are never cached, and failures are never cached. The cache key is the URL plus
mode (text vs html).

## Wait-for and proxy

`--wait-for <selector>` makes the browser wait for that element before extracting,
which is faster and more reliable than the fixed wait on JS-heavy pages. If the
selector never appears it logs and proceeds rather than hanging. Without the flag,
the default wait is unchanged.

`--proxy <url>` routes the browser layer (`http(s)://` or `socks5://`). It does not
affect the API handlers or defuddle, which use Node's fetch, so pair it with
`--method browser` when you need everything proxied.

## Batch mode

Pass two or more URLs and the skill fetches them concurrently, reusing a single
browser for the run instead of relaunching one per URL. Output is grouped under
`===== URL: ... =====` headers in the original order. Control parallelism with
`--concurrency <n>` (default 4). `--screenshot` is single-URL only.

This is the efficient path for multi-page research (e.g., reading a set of
Reddit threads): one command, one browser launch, parallel fetches.

## Site Handlers

| Site | Method | What You Get |
|------|--------|-------------|
| Reddit | JSON API | Posts and threaded comments, scores, usernames. Search and listing results include each post's permalink, so you can fetch threads directly without scraping links |
| Hacker News | Firebase API | Stories, comment threads (top 20 with 5 replies each) |
| Wikipedia | REST API | Full article text with sections |
| GitHub repos | REST API | Repo info, stats, full README |

## Domain Memory

After each successful fetch, `domains.json` records what worked:

```json
{
  "reddit.com": "handler:reddit",
  "coachsensai.com": "browser",
  "docs.anthropic.com": "defuddle",
  "crates.io": "browser"
}
```

This file persists across sessions. The first time you visit a domain, it cascades. Every time after, it goes straight to what works.

To reset memory for a domain, edit or delete `domains.json`.

## Setup

If not yet installed, run from the skill directory:

```bash
npm run setup
```

This installs Playwright and downloads Chromium (~110 MB one-time download).

**Also required:** Defuddle CLI (for the fast extraction layer):

```bash
npm install -g defuddle
```

If Defuddle is not installed, the skill still works. It just skips the Defuddle layer and goes straight to the browser.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot find module 'playwright'" | Run `npm run setup` from the skill directory |
| Defuddle layer always skipped | Run `npm install -g defuddle` |
| Timeout on slow sites | Use `--wait 8000` for more rendering time |
| Wrong method used for a domain | Delete or edit `domains.json` to reset |
| Site still blocks after stealth | Some sites have aggressive anti-bot beyond what stealth can bypass. Try `--cookies-from <browser>` to read it as your logged-in self |
| `Extracted 0 cookies` / `profile is locked` | The target browser is open and holding its cookie DB. **Close the browser fully**, then retry `--cookies-from chrome`. Or point at the right profile: `--cookies-from "chrome:Profile 2"` |
| Reddit, LinkedIn, etc. return the logged-out view | Those need your session. Use `--cookies-from chrome` (browser closed) so the page renders as you see it |

## Authenticated access (cookies)

For sites that block anonymous access or hide content behind a login (Reddit search, LinkedIn job hiring teams, gated docs), inject your real browser session:

```bash
node <skill-directory>/render.js "<url>" --cookies-from chrome --wait 6000
```

Supported: `chrome`, `edge`, `brave`, `firefox`. Add a profile when cookies live in a non-default profile: `--cookies-from "chrome:Profile 2"`.

**The target browser must be closed.** Chromium browsers lock their cookie database while running, so an open Chrome means zero cookies extracted. Close it fully (check the tray), then run the command. When cookies are present the cascade skips straight to the browser layer, since cookies only apply there.
