#!/bin/bash
set -e

SKILL_DIR="$HOME/.claude/skills/web-reader"
REPO="https://github.com/Hiro-Inagawa/web-reader.git"
TMP_DIR=$(mktemp -d)

echo ""
echo "  Web Reader - Installing..."
echo ""

# Clone repo to temp directory
git clone --depth 1 "$REPO" "$TMP_DIR" 2>/dev/null

# Create skill directory and copy files
mkdir -p "$SKILL_DIR"
cp "$TMP_DIR/skills/web-reader/render.js" "$SKILL_DIR/"
cp "$TMP_DIR/skills/web-reader/cookies.js" "$SKILL_DIR/"
cp "$TMP_DIR/skills/web-reader/query-cookies.py" "$SKILL_DIR/"
cp "$TMP_DIR/skills/web-reader/SKILL.md" "$SKILL_DIR/"
cp "$TMP_DIR/skills/web-reader/package.json" "$SKILL_DIR/"

# Clean up repo
rm -rf "$TMP_DIR"

# Install dependencies and download Chromium
cd "$SKILL_DIR"
npm install --silent 2>/dev/null
npx playwright install chromium 2>/dev/null

# Install defuddle (optional, non-blocking)
if ! command -v defuddle &>/dev/null; then
  echo "  Installing defuddle (fast extraction layer)..."
  npm install -g defuddle --silent 2>/dev/null || echo "  Defuddle install failed (optional, skill works without it)"
fi

echo ""
echo "  Done. Web Reader installed to $SKILL_DIR"
echo ""
echo "  Usage: Ask Claude Code to read any URL, or run directly:"
echo "    node $SKILL_DIR/render.js \"https://example.com\""
echo ""
