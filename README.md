# Web Reader

A Claude Code skill that renders JavaScript-heavy websites (SPAs) using headless Chromium and returns their content.

## The Problem

Claude Code's built-in `WebFetch` tool can't render JavaScript. Most modern websites (React, Next.js, Vue, Angular) return a blank page or just a `<title>` tag. This skill fixes that.

## Installation

### Option 1: Plugin (Recommended)

```bash
/plugin marketplace add Hiro-Inagawa/web-reader
/plugin install web-reader@web-reader
```

Then run setup:

```bash
cd ~/.claude/plugins/marketplaces/web-reader/skills/web-reader
npm run setup
```

### Option 2: Global Skill

```bash
git clone https://github.com/Hiro-Inagawa/web-reader.git /tmp/web-reader
cp -r /tmp/web-reader/skills/web-reader ~/.claude/skills/
cd ~/.claude/skills/web-reader
npm run setup
rm -rf /tmp/web-reader
```

### Option 3: Project Skill

```bash
git clone https://github.com/Hiro-Inagawa/web-reader.git /tmp/web-reader
mkdir -p .claude/skills
cp -r /tmp/web-reader/skills/web-reader .claude/skills/
cd .claude/skills/web-reader
npm run setup
rm -rf /tmp/web-reader
```

## Usage

Once installed, just ask Claude Code to look at any website:

```
"Read this website: https://example.com"
"What's on this page: https://some-spa-app.com"
"Check out https://coachsensai.com and tell me what they do"
```

Claude will automatically use the skill when `WebFetch` fails on JavaScript-heavy sites.

### Direct Usage

```bash
# Get text content
node render.js "https://example.com"

# Take a screenshot
node render.js "https://example.com" --screenshot

# Get raw HTML
node render.js "https://example.com" --html

# Wait longer for slow sites
node render.js "https://example.com" --wait 8000
```

## How It Works

1. Launches headless Chromium via Playwright
2. Navigates to the URL
3. Waits for network requests to finish + a buffer for late-loading content
4. Extracts all visible text from the rendered page
5. Returns it to Claude Code

That's it. No testing framework, no automation helpers, no complex configuration. Just: **URL in, content out.**

## Requirements

- Node.js v18+
- ~110 MB disk space (for Chromium, downloaded once during setup)

## License

MIT
