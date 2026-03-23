# Web Reader

Renders JavaScript-heavy websites (SPAs) using headless Chromium and returns their text content. Use this when `WebFetch` or `defuddle` fail because a site requires JavaScript to render.

## When to Use

- User shares a URL and the site is a JavaScript SPA (React, Next.js, Vue, Angular, etc.)
- `WebFetch` returns only a page title or "requires JavaScript"
- User asks to "look at", "read", or "check" a website that doesn't render without JS

## Usage

Run the `render.js` script with the URL as argument:

```bash
node <skill-directory>/render.js "https://example.com"
```

The script:
1. Launches headless Chromium
2. Navigates to the URL
3. Waits for JavaScript to finish rendering (networkidle + 3s buffer)
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
| Site blocks headless browsers | Some sites detect and block automation; nothing we can do |
