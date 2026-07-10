import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { shouldCaptureResponse, redactRequestPostData } from './tzzb-capture-lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const targetUrl = 'https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/gcQSW6A';
const outputDir = path.resolve('data/tzzb');
const captured = [];

await fs.mkdir(outputDir, { recursive: true });

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'msedge', headless: false });
  } catch {
    return chromium.launch({ headless: false });
  }
}

const browser = await launchBrowser();
const page = await browser.newPage();

page.on('response', async (response) => {
  if (!shouldCaptureResponse(response)) return;

  try {
    const text = await response.text();
    const record = {
      capturedAt: new Date().toISOString(),
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
      requestPostData: redactRequestPostData(response.request().postData()),
      responseText: text
    };
    captured.push(record);
    console.log(`[capture] ${record.status} ${record.method} ${record.url}`);
  } catch (error) {
    console.log(`[skip] ${response.request().method()} ${response.url()}: ${error.message}`);
  }
});

await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
console.log('请在打开的浏览器里手动登录投资账本。');
console.log('等账户页面加载完成后，回到这里按 Enter 保存捕获到的只读响应。');

process.stdin.resume();
await new Promise((resolve) => process.stdin.once('data', resolve));

const outputPath = path.join(outputDir, `raw-responses-${Date.now()}.json`);
await fs.writeFile(outputPath, JSON.stringify(captured, null, 2), 'utf8');
console.log(`Saved ${captured.length} responses to ${outputPath}`);

await browser.close();
