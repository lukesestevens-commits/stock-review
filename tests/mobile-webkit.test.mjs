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
    const htmlStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const shellStyle = getComputedStyle(shell);
    return {
      viewportContent: document.querySelector('meta[name="viewport"]').content,
      dateInsideField: dateBox.left >= fieldBox.left - 1 && dateBox.right <= fieldBox.right + 1,
      dateAppearance: getComputedStyle(date).appearance,
      shellPosition: shellStyle.position,
      documentScrolls: htmlStyle.overflowY !== 'hidden' && bodyStyle.overflowY !== 'hidden' && shellStyle.overflowY !== 'auto',
      shellTallerThanViewport: shellBox.height > innerHeight + 200,
      pageOverflow: document.documentElement.scrollWidth - innerWidth
    };
  });

  assert.match(metrics.viewportContent, /viewport-fit=cover/);
  assert.equal(metrics.dateInsideField, true, `WebKit ${viewport.width}x${viewport.height} date input should stay inside its field`);
  assert.equal(metrics.dateAppearance, 'none', `WebKit ${viewport.width}x${viewport.height} should normalize date appearance`);
  assert.equal(metrics.shellPosition, 'relative', `WebKit ${viewport.width}x${viewport.height} shell should stay in document flow`);
  assert.equal(metrics.documentScrolls, true, `WebKit ${viewport.width}x${viewport.height} should use native document scrolling`);
  assert.equal(metrics.shellTallerThanViewport, true, `WebKit ${viewport.width}x${viewport.height} shell should expand with its content`);
  assert.ok(metrics.pageOverflow <= 1, `WebKit ${viewport.width}x${viewport.height} should not overflow horizontally`);
}

try {
  await assertMobileSurface({ width: 390, height: 844 });

  await page.evaluate(() => window.scrollTo(0, 700));
  assert.ok(await page.evaluate(() => window.scrollY) > 0);
  await page.getByRole('button', { name: '回到顶部' }).click();
  await page.waitForFunction(() => window.scrollY === 0);

  await page.evaluate(() => window.scrollTo(0, 500));
  const modalScrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => openOcrModal());
  const modalLock = await page.evaluate(() => ({
    htmlLocked: document.documentElement.classList.contains('modal-open'),
    bodyLocked: document.body.classList.contains('modal-open'),
    bodyPosition: getComputedStyle(document.body).position,
    bodyTop: getComputedStyle(document.body).top
  }));
  assert.equal(modalLock.htmlLocked, true, 'WebKit modal should lock the document root');
  assert.equal(modalLock.bodyLocked, true, 'WebKit modal should lock the page body');
  assert.equal(modalLock.bodyPosition, 'fixed', 'WebKit modal should prevent background page scrolling');
  assert.equal(modalLock.bodyTop, `-${modalScrollY}px`, 'WebKit modal should preserve the visual scroll position');
  await page.evaluate(() => closeOcrModal());
  await page.waitForFunction((expectedY) => window.scrollY === expectedY, modalScrollY);

  await assertMobileSurface({ width: 844, height: 390 });
  console.log('PASS mobile WebKit layout');
} finally {
  await browser.close();
}
