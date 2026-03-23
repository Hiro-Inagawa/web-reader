#!/usr/bin/env node

const { chromium } = require('playwright');

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--'));

if (!url) {
  console.error('Usage: node render.js <url> [--wait ms] [--screenshot] [--html]');
  process.exit(1);
}

const waitTime = parseInt(args[args.indexOf('--wait') + 1]) || 3000;
const takeScreenshot = args.includes('--screenshot');
const outputHtml = args.includes('--html');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(waitTime);

  if (takeScreenshot) {
    const path = '/tmp/web-reader-screenshot.png';
    await page.screenshot({ path, fullPage: true });
    console.error('Screenshot saved to ' + path);
  }

  if (outputHtml) {
    const html = await page.content();
    console.log(html);
  } else {
    const text = await page.evaluate(() => document.body.innerText);
    console.log(text);
  }

  await browser.close();
})().catch(e => {
  console.error('Error: ' + e.message);
  process.exit(1);
});
