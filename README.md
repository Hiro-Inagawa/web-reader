```
 __      __   _      ___               _
 \ \    / /__| |__  | _ \___ __ _ __ _| |___ _ _
  \ \/\/ / -_) '_ \ |   / -_) _` / _` |  _| '_|
   \_/\_/\___|_.__/ |_|_\___\__,_\__,_|\__|_|

  URL in. Text out. That's it.
```

# Web Reader

**Read any website, including JavaScript SPAs, from Claude Code. One script, 30 lines.**

A Claude Code skill that renders JavaScript-heavy websites and returns their text content. No automation suite. No API keys. No running servers. Just: URL in, text out.

## Why This Exists

Claude Code's built-in `WebFetch` [cannot render JavaScript](https://docs.anthropic.com/en/docs/claude-code). Anthropic documents this limitation themselves. That means any modern SPA -- React, Next.js, Vue, Angular -- returns a blank page or just a `<title>` tag.

Sites affected include **crates.io, npmjs.com, Reddit, Medium, Quora**, and most documentation platforms built on Mintlify, GitBook, or Docusaurus.

## Why Not Use an Existing Solution?

Every alternative bundles full browser automation far beyond simple content reading:

| Tool | What you get | What you actually needed |
|------|-------------|------------------------|
| [dev-browser](https://github.com/nicholasxwang/dev-browser) (3,800+ stars) | Chrome extension, session management, form filling, AI-optimized DOM snapshots, QuickJS sandbox | Read a webpage |
| [playwright-skill](https://github.com/lackeyjb/playwright-skill) (1,500+ stars) | Full Playwright scripting, visible browser window, test workflows | Read a webpage |
| [Playwright MCP](https://github.com/nicholasxwang/playwright-mcp) (Microsoft) | 26+ tools for browser control, device emulation, accessibility testing | Read a webpage |
| Firecrawl / Bright Data | External paid services with API keys | Read a webpage |

Web Reader does **one thing**: renders a page and gives you the text. That's it. 30 lines of code, zero configuration.

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
3. Waits for JavaScript to finish rendering
4. Extracts all visible text from the rendered page
5. Returns it to Claude Code

No testing framework. No automation helpers. No complex configuration. The entire implementation is [30 lines](skills/web-reader/render.js).

## Requirements

- Node.js v18+
- ~110 MB disk space (for Chromium, downloaded once during setup)

## License

MIT
