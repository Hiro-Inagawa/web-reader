```
 __      __   _      ___               _
 \ \    / /__| |__  | _ \___ __ _ __ _| |___ _ _
  \ \/\/ / -_) '_ \ |   / -_) _` / _` |  _| '_|
   \_/\_/\___|_.__/ |_|_\___\__,_\__,_|\__|_|

  URL in. Text out. That's it.
```

# Web Reader

**Read any website, including JavaScript SPAs, from Claude Code. One skill, all websites.**

A Claude Code skill that reads any URL using the fastest method that works. It cascades through three layers automatically, then remembers what worked so the next request is instant.

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
           Headless Chromium with bot-detection bypass.
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
```

## Site Handlers

Sites that block browsers or have better APIs get dedicated handlers:

| Site | Method | Output |
|------|--------|--------|
| Reddit | JSON API | Posts, threaded comments, scores |
| Hacker News | Firebase API | Stories, comment threads |
| Wikipedia | REST API | Full article text |
| GitHub repos | REST API | Repo info, stats, README |

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

## Requirements

- Node.js v18+
- ~110 MB disk space (for Chromium, downloaded once during setup)
- Optional: `defuddle` CLI for Layer 2

## License

MIT
