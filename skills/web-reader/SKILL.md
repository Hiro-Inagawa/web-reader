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
```

## Site Handlers

| Site | Method | What You Get |
|------|--------|-------------|
| Reddit | JSON API | Posts, comments with threading, scores, usernames |
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
| Site still blocks after stealth | Some sites have aggressive anti-bot beyond what stealth can bypass |
