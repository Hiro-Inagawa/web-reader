# Web Reader

Renders JavaScript-heavy websites (SPAs) using headless Chromium and returns their text content. Includes stealth mode to bypass Cloudflare and common bot detection, plus built-in handlers for sites like Reddit. Use this when `WebFetch` or `defuddle` fail because a site requires JavaScript to render or blocks automated access.

## When to Use

- User shares a URL and the site is a JavaScript SPA (React, Next.js, Vue, Angular, etc.)
- `WebFetch` returns only a page title or "requires JavaScript"
- User asks to "look at", "read", or "check" a website that doesn't render without JS
- URL is a Reddit link (threads, subreddits, user profiles)
- Site uses Cloudflare or other bot detection that blocks `WebFetch`

## Usage

Run the `render.js` script with the URL as argument:

```bash
node <skill-directory>/render.js "https://example.com"
```

The script:
1. Checks for site-specific handlers (e.g. Reddit URLs use the JSON API directly)
2. For all other sites, launches headless Chromium with stealth measures
3. Navigates to the URL and waits for JavaScript to finish rendering
4. Prints all visible text content to stdout
5. Exits cleanly

## Options

Pass options as additional arguments:

```bash
# Custom wait time (milliseconds, default: 3000)
node <skill-directory>/render.js "https://example.com" --wait 5000

# Take a screenshot (saved to /tmp/web-reader-screenshot.png)
node <skill-directory>/render.js "https://example.com" --screenshot

# Get raw HTML instead of text
node <skill-directory>/render.js "https://example.com" --html
```

## Supported Sites

| Site | Method |
|------|--------|
| Reddit (threads, subreddits) | JSON API with structured output |
| Cloudflare-protected sites | Stealth browser (webdriver flag hidden, real user-agent) |
| JavaScript SPAs | Headless Chromium rendering |
| Static sites | Works too, but `defuddle` is faster for these |

## Setup

If not yet installed, run from the skill directory:

```bash
npm run setup
```

This installs Playwright and downloads Chromium (~110 MB one-time download).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot find module 'playwright'" | Run `npm run setup` from the skill directory |
| Timeout on slow sites | Use `--wait 8000` for more rendering time |
| Site still blocks after stealth | Some sites have aggressive anti-bot measures beyond what stealth can bypass |
