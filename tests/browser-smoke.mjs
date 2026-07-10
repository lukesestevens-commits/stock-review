import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const pageUrl = new URL('../index.html', import.meta.url).href;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

page.on('dialog', dialog => dialog.accept());
await page.goto(pageUrl);

await assert.doesNotReject(async () => {
  await page.locator('summary', { hasText: '备用工具' }).click();
  await page.locator('button', { hasText: '截图智能导入' }).first().click();
});
await assert.ok(await page.locator('#ocrModal.show').isVisible(), 'OCR modal should open');

await page.locator('#ocrLayout').selectOption('pc');
await page.locator('#ocrWriteMode').selectOption('replace');
await page.locator('#ocrRawText').fill(`成交时间 证券名称 操作 成交价格 成交数量 成交金额
09:31:08 江波龙 买入 88.50 100 8850.00
13:42:19 中际旭创 卖出 145.20 200 29040.00
总资产 205000.35 今日盈亏 +1280.55 持仓市值 102500.00`);
await page.locator('button', { hasText: '解析右侧文本' }).click();
await assert.equal(await page.locator('#ocrTradePreviewBody tr').count(), 2);
await page.locator('button', { hasText: '确认写入表单' }).click();

await assert.equal(await page.locator('#capital').inputValue(), '205000.35');
await assert.equal(await page.locator('#pnl').inputValue(), '+1280.55');
await assert.equal(await page.locator('#position').inputValue(), '5成');
await assert.equal(await page.locator('#tradeBody tr').count(), 2);

await page.locator('button', { hasText: '生成复盘文本' }).click();
const output = await page.locator('#output').textContent();
assert.match(output, /复盘质量与风险提醒/);
assert.match(output, /截图导入摘要：本次导入：2 笔交易/);

await page.locator('button', { hasText: '保存今日复盘' }).click();
await assert.equal(await page.locator('#historyCount').textContent(), '1');

await page.setViewportSize({ width: 390, height: 844 });
await page.reload();
const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(pageOverflow <= 4, `mobile page should not overflow horizontally, overflow=${pageOverflow}`);
await page.locator('summary', { hasText: '备用工具' }).click();
await page.locator('button', { hasText: '截图智能导入' }).first().click();
const modalBox = await page.locator('#ocrModal .modal').boundingBox();
assert.ok(modalBox.width <= 390, `mobile modal should fit viewport, width=${modalBox.width}`);

await browser.close();
console.log('PASS browser smoke');
