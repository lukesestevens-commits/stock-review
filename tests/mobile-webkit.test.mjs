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
  await page.evaluate(() => {
    document.querySelector('.discipline-settings').open = true;
  });

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
    const disciplinePanel = document.querySelector('.discipline-panel');
    const settingsFields = [...document.querySelectorAll('.discipline-settings-grid .field')];
    const settingsControls = settingsFields.map((settingsField) => settingsField.querySelector('input'));
    const visibleEditableControls = [...document.querySelectorAll('input,select,textarea')]
      .filter((control) => !['checkbox', 'radio', 'hidden'].includes(control.type) && control.getClientRects().length);
    const escapedSettingsControls = settingsControls.filter((control, index) => {
      const controlBox = control.getBoundingClientRect();
      const fieldBox = settingsFields[index].getBoundingClientRect();
      const panelBox = disciplinePanel.getBoundingClientRect();
      return controlBox.left < fieldBox.left - 1 || controlBox.right > fieldBox.right + 1
        || controlBox.left < panelBox.left - 1 || controlBox.right > panelBox.right + 1;
    });
    const fieldWidths = settingsFields.map((settingsField) => settingsField.getBoundingClientRect().width);
    const controlHeights = settingsControls.map((control) => control.getBoundingClientRect().height);
    const sectionStyle = getComputedStyle(document.querySelector('.section'));
    const innerFieldStyle = getComputedStyle(document.querySelector('.section .field'));
    const viewportMeta = document.querySelector('meta[name="viewport"]').content;
    return {
      viewportContent: viewportMeta,
      viewportKeepsUserZoom: !/user-scalable\s*=\s*no/i.test(viewportMeta) && !/maximum-scale\s*=\s*1/i.test(viewportMeta),
      dateInsideField: dateBox.left >= fieldBox.left - 1 && dateBox.right <= fieldBox.right + 1,
      dateAppearance: getComputedStyle(date).appearance,
      timeAppearance: getComputedStyle(document.querySelector('#openingWindowStart')).appearance,
      shellPosition: shellStyle.position,
      documentScrolls: htmlStyle.overflowY !== 'hidden' && bodyStyle.overflowY !== 'hidden' && shellStyle.overflowY !== 'auto',
      shellTallerThanViewport: shellBox.height > innerHeight + 200,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      editableFontSizes: visibleEditableControls.map((control) => Number.parseFloat(getComputedStyle(control).fontSize)),
      escapedSettingsControlCount: escapedSettingsControls.length,
      fieldWidthSpread: Math.max(...fieldWidths) - Math.min(...fieldWidths),
      controlHeightSpread: Math.max(...controlHeights) - Math.min(...controlHeights),
      sectionBackground: sectionStyle.backgroundColor,
      sectionBorder: sectionStyle.borderColor,
      fieldBackground: innerFieldStyle.backgroundColor,
      fieldBorder: innerFieldStyle.borderColor
    };
  });

  assert.match(metrics.viewportContent, /viewport-fit=cover/);
  assert.equal(metrics.viewportKeepsUserZoom, true, `WebKit ${viewport.width}x${viewport.height} should preserve manual zoom`);
  assert.equal(metrics.dateInsideField, true, `WebKit ${viewport.width}x${viewport.height} date input should stay inside its field`);
  assert.equal(metrics.dateAppearance, 'none', `WebKit ${viewport.width}x${viewport.height} should normalize date appearance`);
  assert.equal(metrics.timeAppearance, 'none', `WebKit ${viewport.width}x${viewport.height} should normalize time appearance`);
  assert.equal(metrics.shellPosition, 'relative', `WebKit ${viewport.width}x${viewport.height} shell should stay in document flow`);
  assert.equal(metrics.documentScrolls, true, `WebKit ${viewport.width}x${viewport.height} should use native document scrolling`);
  assert.equal(metrics.shellTallerThanViewport, true, `WebKit ${viewport.width}x${viewport.height} shell should expand with its content`);
  assert.ok(metrics.pageOverflow <= 1, `WebKit ${viewport.width}x${viewport.height} should not overflow horizontally`);
  assert.ok(metrics.editableFontSizes.every((size) => size >= 16), `WebKit ${viewport.width}x${viewport.height} controls should avoid iOS focus zoom`);
  assert.equal(metrics.escapedSettingsControlCount, 0, `WebKit ${viewport.width}x${viewport.height} discipline controls should stay inside both card layers`);
  assert.ok(metrics.fieldWidthSpread <= 1, `WebKit ${viewport.width}x${viewport.height} discipline cards should align evenly`);
  assert.ok(metrics.controlHeightSpread <= 1, `WebKit ${viewport.width}x${viewport.height} discipline controls should share one height`);
  assert.notEqual(metrics.sectionBackground, metrics.fieldBackground, `WebKit ${viewport.width}x${viewport.height} outer and inner cards should use distinct surfaces`);
  assert.notEqual(metrics.sectionBorder, metrics.fieldBorder, `WebKit ${viewport.width}x${viewport.height} outer and inner cards should use distinct borders`);
}

try {
  await assertMobileSurface({ width: 390, height: 844 });

  await page.evaluate(() => {
    if (!document.querySelector('#holdingBody tr:not(.holding-empty)')) {
      addHoldingReviewRow({
        name: '测试持仓', code: '000001', value: '10000', weight: '20%', isCore: '核心',
        logic: '逻辑仍然成立', tomorrowAction: '观察', trigger: '跌破计划位减仓'
      });
    }
  });
  const holdingCard = await page.locator('#holdingBody tr:not(.holding-empty)').evaluate((row) => {
    const wrap = row.closest('.holding-table-wrap');
    const rowBox = row.getBoundingClientRect();
    const visibleControls = [...row.querySelectorAll('input,select,textarea,button')]
      .filter((control) => control.getClientRects().length);
    const escaped = visibleControls.filter((control) => {
      const box = control.getBoundingClientRect();
      return box.left < rowBox.left - 1 || box.right > rowBox.right + 1;
    });
    const coreWidth = row.querySelector('.holding-core-cell').getBoundingClientRect().width;
    const actionWidth = row.querySelector('.holding-action-cell').getBoundingClientRect().width;
    return {
      display: getComputedStyle(row).display,
      labels: [...row.querySelectorAll('td')].map((cell) => cell.dataset.label),
      controlOrder: visibleControls.map((control) => control.classList[0] || control.tagName.toLowerCase()),
      wrapOverflow: wrap.scrollWidth - wrap.clientWidth,
      escapedControlCount: escaped.length,
      pairedSelectWidthSpread: Math.abs(coreWidth - actionWidth)
    };
  });
  assert.equal(holdingCard.display, 'grid', 'WebKit mobile holdings should render as cards');
  assert.deepEqual(holdingCard.labels, ['股票/ETF', '市值 / 仓位', '是否核心', '明日处理', '持仓逻辑', '触发条件', '操作']);
  assert.deepEqual(
    holdingCard.controlOrder,
    ['holding-name', 'holding-code', 'holding-value', 'holding-weight', 'holding-core', 'holding-action', 'holding-logic', 'holding-trigger', 'btn-danger'],
    'WebKit holding tab order should follow the visual top-to-bottom form order'
  );
  assert.ok(holdingCard.wrapOverflow <= 1, 'WebKit mobile holding cards should not require horizontal scrolling');
  assert.equal(holdingCard.escapedControlCount, 0, 'WebKit mobile holding controls should stay inside the card');
  assert.ok(holdingCard.pairedSelectWidthSpread <= 1, 'WebKit mobile holding decisions should use equal columns');

  await page.evaluate(() => window.scrollTo(0, 700));
  assert.ok(await page.evaluate(() => window.scrollY) > 0);
  assert.equal(await page.locator('.fab').isVisible(), false, 'mobile fixed FAB should stay hidden so it cannot overlap trade controls');
  await page.evaluate(() => scrollReviewToTop());
  await page.waitForFunction(() => window.scrollY === 0);

  await page.evaluate(() => {
    document.querySelector('.secondary-tools').open = true;
    window.scrollTo(0, 500);
  });
  const modalScrollY = await page.evaluate(() => window.scrollY);
  const ocrTrigger = page.getByRole('button', { name: '截图智能导入' });
  await ocrTrigger.click();
  const modalLock = await page.evaluate(() => ({
    htmlLocked: document.documentElement.classList.contains('modal-open'),
    bodyLocked: document.body.classList.contains('modal-open'),
    bodyPosition: getComputedStyle(document.body).position,
    bodyTop: getComputedStyle(document.body).top,
    focusInside: document.querySelector('#ocrModal').contains(document.activeElement),
    activeLabel: document.activeElement?.getAttribute('aria-label') || '',
    dimmedTheme: document.querySelector('meta[name="theme-color"]')?.content || ''
  }));
  assert.equal(modalLock.htmlLocked, true, 'WebKit modal should lock the document root');
  assert.equal(modalLock.bodyLocked, true, 'WebKit modal should lock the page body');
  assert.equal(modalLock.bodyPosition, 'fixed', 'WebKit modal should prevent background page scrolling');
  assert.equal(modalLock.bodyTop, `-${modalScrollY}px`, 'WebKit modal should preserve the visual scroll position');
  assert.equal(modalLock.focusInside, true, 'WebKit modal should move focus inside the dialog');
  assert.equal(modalLock.activeLabel, '关闭截图导入', 'WebKit modal should focus its close button');
  assert.equal(modalLock.dimmedTheme, '#6f6b64', 'WebKit modal should dim Safari chrome while its backdrop is open');
  await page.keyboard.press('Shift+Tab');
  assert.equal(
    await page.evaluate(() => document.querySelector('#ocrModal').contains(document.activeElement)),
    true,
    'WebKit modal should contain keyboard focus'
  );
  await page.evaluate(() => showNotice('暂无可写入的数据。'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#appNoticeBackdrop').classList.contains('show'));
  assert.equal(await page.locator('#ocrModal').evaluate((modal) => modal.classList.contains('show')), true, 'closing a nested notice should keep the OCR dialog open');
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#6f6b64', 'browser chrome should stay dim while the underlying dialog remains open');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#ocrModal').classList.contains('show'));
  await page.waitForFunction((expectedY) => window.scrollY === expectedY, modalScrollY);
  assert.equal(await ocrTrigger.evaluate((element) => element === document.activeElement), true, 'WebKit modal should restore focus to its opener');
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#f4f1ea', 'WebKit modal should restore browser chrome color');

  await page.evaluate(() => window.scrollTo(0, 900));
  const noticeScrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => showNotice('已复制，可以直接发给 ChatGPT。'));
  const noticeGeometry = await page.evaluate(() => {
    const backdrop = document.querySelector('#appNoticeBackdrop');
    const box = backdrop.getBoundingClientRect();
    return {
      visible: backdrop.classList.contains('show'),
      top: box.top,
      bottomGap: innerHeight - box.bottom,
      left: box.left,
      rightGap: innerWidth - box.right,
      bodyLocked: document.body.classList.contains('notice-open'),
      bodyPosition: getComputedStyle(document.body).position,
      bodyTop: getComputedStyle(document.body).top,
      dimmedTheme: document.querySelector('meta[name="theme-color"]')?.content || ''
    };
  });
  assert.equal(noticeGeometry.visible, true, 'WebKit notice should use the app overlay instead of a native alert');
  assert.ok(Math.abs(noticeGeometry.top) <= 1 && Math.abs(noticeGeometry.bottomGap) <= 1, 'WebKit notice backdrop should cover the full viewport vertically');
  assert.ok(Math.abs(noticeGeometry.left) <= 1 && Math.abs(noticeGeometry.rightGap) <= 1, 'WebKit notice backdrop should cover the full viewport horizontally');
  assert.equal(noticeGeometry.bodyLocked, true, 'WebKit notice should lock background scrolling');
  assert.equal(noticeGeometry.bodyPosition, 'fixed', 'WebKit notice should keep the page behind it still');
  assert.equal(noticeGeometry.bodyTop, `-${noticeScrollY}px`, 'WebKit notice should preserve the visual scroll position');
  assert.equal(noticeGeometry.dimmedTheme, '#6f6b64', 'WebKit notice should dim Safari chrome using theme-color');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#appNoticeBackdrop').classList.contains('show'));
  await page.waitForFunction((expectedY) => window.scrollY === expectedY, noticeScrollY);
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#f4f1ea', 'WebKit notice should restore browser chrome color');

  await assertMobileSurface({ width: 844, height: 390 });
  console.log('PASS mobile WebKit layout');
} finally {
  await browser.close();
}
