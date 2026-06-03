```
__      _____ ___   ___ ___   _   ___  ___ ___
\ \    / / __| _ ) | _ \ __| /_\ |   \| __| _ \
 \ \/\/ /| _|| _ \ |   / _| / _ \| |) | _||   /
  \_/\_/ |___|___/ |_|_\___/_/ \_\___/|___|_|_\

  URL in. Text out. That's it.
```

# Web Reader

**Read any website, including JavaScript SPAs, from Claude Code. One skill, all websites.**

A Claude Code skill that reads any URL using the fastest method that works. It cascades through four layers automatically, caches successful reads, and remembers what worked so the next request is instant. Pass several URLs at once and it fetches them in parallel over a single pooled browser.

```
URL comes in
    |
    +-- 1. Site handler?  (Reddit, HN, Wikipedia, GitHub)
    |      Uses the site's own API. Instant. Structured output.
    |
    +-- 2. Defuddle?      (blogs, docs, news, static sites)
    |      Fast extraction, no browser needed. Handles ~70% of the web.
    |
    +-- 3. Stealth browser (SPAs, Cloudflare, everything else)
    |      Headless Chromium with bot-detection bypass.
    |
    +-- 4. OpenCLI        (when stealth browser is blocked)
           Real Chrome via CDP. Bypasses fingerprinting entirely.
           Skipped automatically if Chrome isn't running.
```

After each successful fetch, it saves the working method to `domains.json`. Next time the same domain is requested, it skips straight to what works.

## Why This Exists

Claude Code's built-in `WebFetch` [cannot render JavaScript](https://docs.anthropic.com/en/docs/claude-code). Anthropic documents this limitation themselves. That means any modern SPA returns a blank page or just a `<title>` tag.

Sites affected include **crates.io, npmjs.com, Reddit, Medium, Quora**, and most documentation platforms built on Mintlify, GitBook, or Docusaurus.

## Why Not Use an Existing Solution?

Every alternative bundles full browser automation far beyond simple content reading:

| Tool | What you get | What you actually needed |
|------|-------------|------------------------|
| [dev-browser](https://github.com/nicholasxwang/dev-browser) (3,800+ stars) | Chrome extension, session management, form filling, AI-optimized DOM snapshots, QuickJS sandbox | Read a webpage |
| [playwright-skill](https://github.com/lackeyjb/playwright-skill) (1,500+ stars) | Full Playwright scripting, visible browser window, test workflows | Read a webpage |
| [Playwright MCP](https://github.com/nicholasxwang/playwright-mcp) (Microsoft) | 26+ tools for browser control, device emulation, accessibility testing | Read a webpage |
| Firecrawl / Bright Data | External paid services with API keys | Read a webpage |

Web Reader does **one thing**: gets you the content of a URL. It just picks the smartest way to do it.

## Installation

One command. Installs the skill, Playwright, Chromium, and Defuddle:

```bash
curl -fsSL https://raw.githubusercontent.com/Hiro-Inagawa/web-reader/main/install.sh | bash
```

That's it. Works on macOS and Linux. On Windows, run it in Git Bash or WSL.

### Alternative: Plugin Marketplace

```bash
/plugin marketplace add Hiro-Inagawa/web-reader
/plugin install web-reader@web-reader
```

Then run setup:

```bash
cd ~/.claude/plugins/marketplaces/web-reader/skills/web-reader
npm run setup
```

### Alternative: Manual Install

```bash
git clone https://github.com/Hiro-Inagawa/web-reader.git /tmp/web-reader
cp -r /tmp/web-reader/skills/web-reader ~/.claude/skills/
cd ~/.claude/skills/web-reader
npm run setup
rm -rf /tmp/web-reader
```

Optionally install Defuddle for the fast extraction layer: `npm install -g defuddle`

## Usage

Once installed, just ask Claude Code to look at any website:

```
"Read this website: https://example.com"
"What's on this page: https://some-spa-app.com"
"Check out https://coachsensai.com and tell me what they do"
```

### Direct Usage

```bash
# Get text content (auto-cascades through methods)
node render.js "https://example.com"

# Force a specific method
node render.js "https://example.com" --method defuddle
node render.js "https://example.com" --method browser

# Take a screenshot (uses browser)
node render.js "https://example.com" --screenshot

# Get raw HTML (uses browser)
node render.js "https://example.com" --html

# Wait longer for slow sites
node render.js "https://example.com" --wait 8000

# Wait for specific content before extracting (faster, more reliable than a fixed wait)
node render.js "https://example.com" --wait-for "main article"

# Route the browser layer through a proxy (http(s):// or socks5://)
node render.js "https://example.com" --method browser --proxy "http://host:8080"
```

### Batch mode

Pass two or more URLs and they're fetched concurrently, reusing a single browser for the whole run instead of relaunching one per URL. Output is grouped under `===== URL: ... =====` headers in input order.

```bash
node render.js "https://a.com" "https://b.com" "https://c.com" --concurrency 4
```

`--concurrency` defaults to 4. `--screenshot` is single-URL only.

### Response cache

Successful reads are cached on disk (in `.cache/`, beside `domains.json`), so re-reading the same URL within the TTL returns instantly instead of re-rendering. On by default with a 15-minute TTL.

```bash
node render.js "https://example.com"               # cached for 15 minutes
node render.js "https://example.com" --no-cache     # always fetch fresh
node render.js "https://example.com" --cache-ttl 60 # 60-minute TTL
```

Authenticated (`--cookies-from`) and screenshot fetches are never cached, and failures are never cached. The cache key is the URL plus mode (text vs HTML).

### Authenticated Access

Read pages that require login by using your existing browser cookies. If you're logged into a site in Chrome, Edge, Brave, or Firefox, Web Reader can use those same cookies.

```bash
# Use cookies from your browser (auto-extracts and decrypts)
node render.js "https://example.com/dashboard" --cookies-from chrome
node render.js "https://example.com/dashboard" --cookies-from edge
node render.js "https://example.com/dashboard" --cookies-from firefox

# Use a Netscape-format cookie file (exported from browser extensions)
node render.js "https://example.com/dashboard" --cookies cookies.txt
```

When cookies are provided, Web Reader skips the handler and defuddle layers and goes straight to the stealth browser with your cookies injected.

**How it works:**

- **Chrome/Edge/Brave (Windows):** Extracts the AES-256 master key from `Local State` via DPAPI, then decrypts each cookie value from the SQLite database. Requires Python for SQLite access (handles WAL journals and browser locks).
- **Firefox (all platforms):** Reads cookies directly from `cookies.sqlite` (unencrypted).
- **Cookie files:** Parses standard Netscape/curl format (tab-separated, used by most cookie export extensions).

**Limitations:**

- Chrome/Edge/Brave extraction is Windows-only (macOS needs Keychain, Linux needs libsecret)
- Edge holds an exclusive lock on its cookie database while running. Close Edge briefly, or use a cookie file instead
- Chrome allows shared reads while running (works without closing)

## Battle-Tested Sites

These are sites known for aggressive bot detection, JavaScript-only rendering, or outright blocking of automated tools. Web Reader handles all of them.

| Site | Why It's Hard | How Web Reader Handles It |
|------|---------------|--------------------------|
| **LinkedIn** | Aggressive bot detection, login walls, fingerprinting | Stealth browser bypasses detection |
| **Reddit** | Blocks scrapers, requires authentication for web | JSON API handler (no browser needed) |
| **Hacker News** | JavaScript-rendered comment trees | Firebase API handler (structured data) |
| **Medium** | Paywall, JavaScript-only rendering | Stealth browser with full JS execution |
| **Cloudflare-protected sites** | JavaScript challenges, bot detection | Stealth browser passes challenges |
| **React/Vue/Angular SPAs** | Content rendered entirely in JavaScript | Stealth browser waits for render |
| **GitHub** | API rate limits, complex page structures | REST API handler (repos, issues, PRs) |
| **Wikipedia** | Not hard, but API is faster than scraping | REST API handler (instant, structured) |
| **Crates.io / npmjs.com** | JavaScript-only package pages | Stealth browser |
| **Docusaurus / GitBook / Mintlify docs** | SPA documentation platforms | Defuddle or stealth browser |

> Most scraping tools, MCP servers, and browser automation frameworks fail on LinkedIn. Web Reader's stealth layer (hidden `navigator.webdriver`, injected plugins, real Chrome fingerprint) makes the difference.

## Site Handlers

Sites with public APIs get dedicated handlers that are faster and more reliable than any browser:

| Site | Method | Output |
|------|--------|--------|
| Reddit | JSON API | Posts, threaded comments, scores; search/listing include permalinks |
| Hacker News | Firebase API | Stories, comment threads |
| Wikipedia | REST API | Full article text |
| GitHub repos | REST API | Repo info, stats, README |
| GitHub issues/PRs | REST API | Title, body, comments, labels |

Handlers are tried first because they're fastest and most reliable. Adding a new handler is just adding a `match` + `fetch` function to the `handlers` object in `render.js`.

## Domain Memory

`domains.json` builds up automatically as you use the skill:

```json
{
  "reddit.com": "handler:reddit",
  "coachsensai.com": "browser",
  "docs.anthropic.com": "defuddle",
  "crates.io": "browser",
  "en.wikipedia.org": "handler:wikipedia"
}
```

First visit to a domain: cascades through all layers. Every visit after: instant routing. Delete or edit the file to reset.

## Verification

A manual verification script tests the skill against real websites. Not for CI (live sites are inherently flaky), but useful after making changes.

```bash
node verify.js              # Run all checks (includes browser tests)
node verify.js --quick      # Skip slow browser tests
node verify.js wikipedia    # Run one specific check
```

The script uses a temp `domains.json` so it doesn't pollute your real domain memory.

## Requirements

- Node.js v18+
- Python 3.6+ (for browser cookie extraction only)
- ~110 MB disk space (for Chromium, downloaded once during setup)
- Optional: `defuddle` CLI for Layer 2

## License

MIT
