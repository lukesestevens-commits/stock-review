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
    const innerField = document.querySelector('.section .field');
    const innerFieldStyle = getComputedStyle(innerField);
    const innerControlStyle = getComputedStyle(innerField.querySelector('input,select,textarea'));
    const sectionHeadStyle = getComputedStyle(document.querySelector('.section-head'));
    const mainLines = document.querySelector('#mainLines');
    mainLines.value = '存储芯片、液冷、CPO、PCB、券商、机器人、低空经济、半导体设备、人工智能';
    mainLines.scrollLeft = mainLines.scrollWidth;
    const mainLinesStyle = getComputedStyle(mainLines);
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
      fieldBorderWidth: innerFieldStyle.borderTopWidth,
      controlBackground: innerControlStyle.backgroundColor,
      controlBorderWidth: innerControlStyle.borderTopWidth,
      sectionHeadBorderWidth: sectionHeadStyle.borderBottomWidth,
      mainLinesOverflowX: mainLinesStyle.overflowX,
      mainLinesWhiteSpace: mainLinesStyle.whiteSpace,
      mainLinesScrollWidth: mainLines.scrollWidth,
      mainLinesClientWidth: mainLines.clientWidth,
      mainLinesScrollLeft: mainLines.scrollLeft
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
  assert.equal(metrics.escapedSettingsControlCount, 0, `WebKit ${viewport.width}x${viewport.height} discipline controls should stay inside their module`);
  assert.ok(metrics.fieldWidthSpread <= 1, `WebKit ${viewport.width}x${viewport.height} discipline cards should align evenly`);
  assert.ok(metrics.controlHeightSpread <= 1, `WebKit ${viewport.width}x${viewport.height} discipline controls should share one height`);
  assert.equal(metrics.fieldBackground, 'rgba(0, 0, 0, 0)', `WebKit ${viewport.width}x${viewport.height} field wrappers should not draw a second box`);
  assert.equal(Number.parseFloat(metrics.fieldBorderWidth), 0, `WebKit ${viewport.width}x${viewport.height} field wrappers should not add an outline`);
  assert.notEqual(metrics.controlBackground, 'rgba(0, 0, 0, 0)', `WebKit ${viewport.width}x${viewport.height} controls should keep their own surface`);
  assert.ok(Number.parseFloat(metrics.controlBorderWidth) >= 1, `WebKit ${viewport.width}x${viewport.height} controls should keep their own outline`);
  assert.notEqual(metrics.sectionBackground, metrics.controlBackground, `WebKit ${viewport.width}x${viewport.height} modules and controls should use distinct surfaces`);
  assert.equal(Number.parseFloat(metrics.sectionHeadBorderWidth), 0, `WebKit ${viewport.width}x${viewport.height} section headings should not add a connected divider`);
  assert.equal(metrics.mainLinesOverflowX, 'auto', `WebKit ${viewport.width}x${viewport.height} long market lines should declare horizontal scrolling`);
  assert.equal(metrics.mainLinesWhiteSpace, 'nowrap', `WebKit ${viewport.width}x${viewport.height} long market lines should remain on one line`);
  if (viewport.width <= 620) {
    assert.ok(metrics.mainLinesScrollWidth > metrics.mainLinesClientWidth, `WebKit ${viewport.width}x${viewport.height} long market lines should overflow only inside their input`);
    assert.ok(metrics.mainLinesScrollLeft > 0, `WebKit ${viewport.width}x${viewport.height} long market lines should scroll horizontally`);
  }
}

try {
  await assertMobileSurface({ width: 390, height: 844 });

  const tradeCard = await page.locator('#tradeTable tbody tr:first-child').evaluate((row) => {
    const wrapper = row.closest('.trade-table-wrap');
    const wrapperStyle = getComputedStyle(wrapper);
    const rowStyle = getComputedStyle(row);
    const rowBox = row.getBoundingClientRect();
    const nextRow = row.nextElementSibling;
    const sideBox = row.querySelector('.trade-side').getBoundingClientRect();
    const priceBox = row.querySelector('.trade-price').getBoundingClientRect();
    const timeBox = row.querySelector('.trade-time').getBoundingClientRect();
    const deleteBox = row.querySelector('.trade-action-cell .btn-danger').getBoundingClientRect();
    return {
      wrapperBackground: wrapperStyle.backgroundColor,
      wrapperShadow: wrapperStyle.boxShadow,
      rowBackground: rowStyle.backgroundColor,
      rowBorderWidth: rowStyle.borderTopWidth,
      rowGap: nextRow ? nextRow.getBoundingClientRect().top - rowBox.bottom : Number.POSITIVE_INFINITY,
      sidePriceWidthSpread: Math.abs(sideBox.width - priceBox.width),
      actionDisplay: getComputedStyle(row.querySelector('.trade-action-cell')).display,
      deleteTopDelta: Math.abs(deleteBox.top - timeBox.top),
      deleteBottomDelta: Math.abs(deleteBox.bottom - timeBox.bottom),
      wrapperOverflow: wrapper.scrollWidth - wrapper.clientWidth
    };
  });
  assert.equal(tradeCard.wrapperBackground, 'rgba(0, 0, 0, 0)', 'WebKit trade wrapper should stay transparent around rounded cards');
  assert.equal(tradeCard.wrapperShadow, 'none', 'WebKit trade wrapper should not visually connect separate records');
  assert.notEqual(tradeCard.rowBackground, 'rgba(0, 0, 0, 0)', 'WebKit each trade record should paint its own card');
  assert.ok(Number.parseFloat(tradeCard.rowBorderWidth) >= 1, 'WebKit each trade record should keep its own outline');
  assert.ok(tradeCard.rowGap >= 8, 'WebKit trade records should keep a visible gap');
  assert.ok(tradeCard.sidePriceWidthSpread <= 1, 'WebKit buy/sell and visible transaction value should use equal widths');
  assert.equal(tradeCard.actionDisplay, 'flex', 'WebKit delete action should align as a field row');
  assert.ok(tradeCard.deleteTopDelta <= 1 && tradeCard.deleteBottomDelta <= 1, 'WebKit delete action should align with the first input row');
  assert.ok(tradeCard.wrapperOverflow <= 1, 'WebKit trade cards should not overflow horizontally');

  const scoreTiles = await page.locator('.scorebar').evaluate((scorebar) => {
    const boxes = [...scorebar.querySelectorAll('.score-item')].map((item) => item.getBoundingClientRect());
    return boxes.map((box) => ({ left: box.left, top: box.top, width: box.width, height: box.height }));
  });
  const [firstScore, secondScore, thirdScore, fourthScore] = scoreTiles;
  assert.ok(Math.abs(firstScore.top - secondScore.top) <= 1 && Math.abs(thirdScore.top - fourthScore.top) <= 1, 'WebKit scores should form two rows');
  assert.ok(Math.abs(firstScore.left - thirdScore.left) <= 1 && Math.abs(secondScore.left - fourthScore.left) <= 1, 'WebKit scores should form two columns');
  assert.ok(Math.abs(firstScore.width - secondScore.width) <= 1 && Math.abs(firstScore.height - secondScore.height) <= 1, 'WebKit score tiles should be equally sized');

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
