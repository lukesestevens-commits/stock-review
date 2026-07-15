import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const pageUrl = new URL('../index.html', import.meta.url).href;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('http://127.0.0.1:8787/**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false })
  }));
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const foldedDetails = await page.evaluate(() => ({
    disciplineOpen: document.querySelector('.discipline-settings').open,
    disciplineBodyHeight: document.querySelector('.discipline-settings-grid').getBoundingClientRect().height,
    backupOpen: document.querySelector('.history-backup-tools').open,
    backupBodyHeight: document.querySelector('.history-backup-tools > .toolbar').getBoundingClientRect().height
  }));
  assert.deepEqual(foldedDetails, {
    disciplineOpen: false,
    disciplineBodyHeight: 0,
    backupOpen: false,
    backupBodyHeight: 0
  }, 'closed P2 details must not display or overlap later sections');

  const trigger = page.locator('.command-trigger');
  await trigger.focus();
  await page.keyboard.press('Meta+K');
  await page.locator('#commandPaletteBackdrop.show').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'commandSearch');
  assert.equal(await page.locator('#commandSearch').evaluate((element) => element === document.activeElement), true);
  await page.locator('#commandSearch').fill('越跌越买');
  assert.match(await page.locator('#commandResults').innerText(), /向下加仓/);
  assert.match(await page.locator('#commandSearch').getAttribute('aria-activedescendant'), /^command-option-\d+$/);

  const paletteGeometry = await page.locator('#commandPalette').evaluate((palette) => {
    const box = palette.getBoundingClientRect();
    return {
      inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      pageOverflow: document.documentElement.scrollWidth - innerWidth
    };
  });
  assert.equal(paletteGeometry.inside, true, 'mobile command palette should stay inside the viewport');
  assert.ok(paletteGeometry.pageOverflow <= 1, 'opening command search should not create horizontal overflow');

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#commandPaletteBackdrop').getAttribute('aria-hidden'), 'true');
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, 'closing search should restore focus');

  await page.keyboard.press('Meta+K');
  await page.locator('#commandSearch').fill('打开月度诊断');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'historyMonth');

  await page.evaluate(() => {
    document.querySelector('.secondary-tools').open = true;
  });
  await page.getByRole('button', { name: '截图智能导入' }).click();
  await page.keyboard.press('Meta+K');
  assert.equal(await page.locator('#commandPaletteBackdrop').getAttribute('aria-hidden'), 'true', 'command search must not open above the OCR dialog');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#ocrModal').evaluate((modal) => modal.contains(document.activeElement)), true, 'OCR focus should remain trapped in the active dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#ocrModal').getAttribute('aria-hidden'), 'true');

  await page.locator('#capital').fill('100000');
  await page.locator('#position').selectOption({ label: '8成' });
  const firstTrade = page.locator('#tradeBody tr').first();
  await firstTrade.locator('.trade-time').fill('09:40');
  await firstTrade.locator('.trade-name').fill('纪律测试标的');
  await firstTrade.locator('.trade-detail-toggle > summary').click();
  await firstTrade.locator('.trade-amount').fill('20000');
  await firstTrade.locator('.flag-downward-average').check();
  await page.waitForFunction(() => document.getElementById('disciplineAlerts')?.textContent.includes('开盘窗口大额买入'));
  const disciplineText = await page.locator('#disciplineAlerts').innerText();
  assert.match(disciplineText, /开盘窗口大额买入/);
  assert.match(disciplineText, /收盘总仓位偏高/);
  assert.match(disciplineText, /向下加仓/);

  const openingAlert = page.locator('#disciplineAlerts .discipline-alert', { hasText: '开盘窗口大额买入' });
  const acknowledge = openingAlert.locator('button', { hasText: '确认并记录' });
  await acknowledge.click();
  await page.waitForFunction(() => {
    const saved = localStorage.getItem('tradeReviewDataV3') || '';
    return saved.includes('"downwardAverage":true') && !saved.includes('"acknowledged":{}');
  });
  assert.match(await openingAlert.innerText(), /已确认/);
  assert.match(await page.evaluate(() => localStorage.getItem('tradeReviewDataV3') || ''), /"downwardAverage":true/);

  const secondTrade = page.locator('#tradeBody tr').nth(1);
  await secondTrade.locator('.trade-time').fill('09:45');
  await secondTrade.locator('.trade-name').fill('新增风险证据');
  await secondTrade.locator('.trade-side').selectOption({ label: '买入' });
  await secondTrade.locator('.trade-detail-toggle > summary').click();
  await secondTrade.locator('.trade-amount').fill('18000');
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('#disciplineAlerts .discipline-alert')].find((element) => element.textContent.includes('开盘窗口大额买入'));
    return card?.textContent.includes('确认并记录');
  });

  const finalGeometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    hiddenFab: getComputedStyle(document.querySelector('.floating')).display === 'none'
  }));
  assert.ok(finalGeometry.overflow <= 1, 'P2 controls and discipline cards should not overflow mobile width');
  assert.equal(finalGeometry.hiddenFab, true, 'mobile fixed button should not cover discipline or trade controls');
} finally {
  await browser.close();
}

console.log('PASS command palette and discipline acknowledgement browser flow');
