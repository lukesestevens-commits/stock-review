import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { webkit } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const pageUrl = new URL('../index.html', import.meta.url).href;
const browser = await webkit.launch({ headless: true });
const page = await browser.newPage();

page.on('dialog', dialog => dialog.accept());
await page.addInitScript(() => {
  localStorage.setItem('tzzbSyncModeV1', 'cloud');
  localStorage.setItem('tzzbCloudSyncBaseUrlV1', 'https://webkit-layout-test.invalid');
});

async function assertMobileSurface(viewport) {
  await page.setViewportSize(viewport);
  await page.goto(pageUrl);
  await page.locator('text=今日复盘工作台').waitFor();

  const metrics = await page.evaluate(() => {
    const date = document.querySelector('#date');
    const field = date.closest('.field');
    const shell = document.querySelector('.shell');
    const dateBox = date.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    return {
      viewportContent: document.querySelector('meta[name="viewport"]').content,
      dateInsideField: dateBox.left >= fieldBox.left - 1 && dateBox.right <= fieldBox.right + 1,
      dateAppearance: getComputedStyle(date).appearance,
      shellPosition: getComputedStyle(shell).position,
      shellBottomGap: Math.abs(innerHeight - shellBox.bottom),
      pageOverflow: document.documentElement.scrollWidth - innerWidth
    };
  });

  assert.match(metrics.viewportContent, /viewport-fit=cover/);
  assert.equal(metrics.dateInsideField, true, `WebKit ${viewport.width}x${viewport.height} date input should stay inside its field`);
  assert.equal(metrics.dateAppearance, 'none', `WebKit ${viewport.width}x${viewport.height} should normalize date appearance`);
  assert.equal(metrics.shellPosition, 'fixed', `WebKit ${viewport.width}x${viewport.height} shell should cover the viewport`);
  assert.ok(metrics.shellBottomGap <= 1, `WebKit ${viewport.width}x${viewport.height} shell should reach the viewport bottom`);
  assert.ok(metrics.pageOverflow <= 1, `WebKit ${viewport.width}x${viewport.height} should not overflow horizontally`);
}

try {
  await assertMobileSurface({ width: 390, height: 844 });

  await page.evaluate(() => { document.querySelector('.shell').scrollTop = 700; });
  assert.ok(await page.evaluate(() => document.querySelector('.shell').scrollTop) > 0);
  await page.getByRole('button', { name: '回到顶部' }).click();
  await page.waitForFunction(() => document.querySelector('.shell').scrollTop === 0);

  await assertMobileSurface({ width: 844, height: 390 });
  console.log('PASS mobile WebKit layout');
} finally {
  await browser.close();
}
