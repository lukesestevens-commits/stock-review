import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const pageUrl = new URL('../index.html', import.meta.url).href;
const viewports = [
  { name: 'desktop', width: 1366, height: 900 },
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'mobile landscape', width: 844, height: 390 },
  { name: 'tablet', width: 768, height: 1024 }
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('dialog', dialog => dialog.accept());
await page.route('http://127.0.0.1:8787/**', async (route) => {
  await route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'layout test has no local helper' })
  });
});

for (const viewport of viewports) {
  const isDesktop = viewport.width >= 981;
  const usesTradeCards = viewport.width <= 620;
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(pageUrl);
  await page.locator('text=今日复盘工作台').waitFor();
  await page.locator('#tradeTable tbody tr:first-child').waitFor();

  const scrollability = await page.evaluate(() => ({
    windowScrollHeight: document.documentElement.scrollHeight,
    windowClientHeight: document.documentElement.clientHeight,
    shellScrollHeight: document.querySelector('.shell').scrollHeight,
    shellClientHeight: document.querySelector('.shell').clientHeight,
    initialWindowY: window.scrollY,
    initialShellY: document.querySelector('.shell').scrollTop
  }));
  assert.ok(
    scrollability.windowScrollHeight > scrollability.windowClientHeight + 200,
    `${viewport.name} browser viewport should own vertical scrolling`
  );
  await page.evaluate(() => window.scrollTo(0, 500));
  const scrolled = await page.evaluate(() => ({
    windowY: window.scrollY,
    shellY: document.querySelector('.shell').scrollTop
  }));
  assert.ok(scrolled.windowY > scrollability.initialWindowY, `${viewport.name} browser viewport should scroll vertically`);
  assert.equal(scrolled.shellY, scrollability.initialShellY, `${viewport.name} shell should not own vertical scrolling`);

  await page.locator('.fab').click();
  await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 1500 });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 4, `${viewport.name} should not overflow page horizontally, overflow=${overflow}`);

  const escapedFields = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.field input,.field select,.field textarea')];
    return controls.filter((el) => {
      const parent = el.closest('.field');
      if (!parent) return false;
      const a = el.getBoundingClientRect();
      const b = parent.getBoundingClientRect();
      return a.left < b.left - 1 || a.right > b.right + 1;
    }).map((el) => el.id || el.placeholder || el.tagName);
  });
  assert.deepEqual(escapedFields, [], `${viewport.name} controls should stay inside field cards`);

  const mobileSurface = await page.evaluate(() => {
    const date = document.querySelector('#date');
    const field = date.closest('.field');
    const shell = document.querySelector('.shell');
    const dateBox = date.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const dateStyle = getComputedStyle(date);
    const shellStyle = getComputedStyle(shell);
    return {
      dateInsideField: dateBox.left >= fieldBox.left - 1 && dateBox.right <= fieldBox.right + 1,
      dateAppearance: dateStyle.appearance,
      shellPosition: shellStyle.position,
      shellOverflowY: shellStyle.overflowY,
      shellTallerThanViewport: shellBox.height > window.innerHeight + 200
    };
  });
  if (!isDesktop) {
    assert.equal(mobileSurface.dateInsideField, true, `${viewport.name} date input should stay inside its field`);
    assert.equal(mobileSurface.dateAppearance, 'none', `${viewport.name} date input should normalize iOS appearance`);
    assert.equal(mobileSurface.shellPosition, 'relative', `${viewport.name} shell should stay in document flow`);
    assert.notEqual(mobileSurface.shellOverflowY, 'auto', `${viewport.name} shell should not be a scroll container`);
    assert.equal(mobileSurface.shellTallerThanViewport, true, `${viewport.name} shell should expand with its content`);
  }

  const tableCheck = await page.evaluate(() => {
    const table = document.querySelector('#tradeTable');
    const wrap = table.closest('.table-wrap');
    const pageOverflow = wrap.getBoundingClientRect().right - document.documentElement.getBoundingClientRect().right;
    const wrapOverflow = table.scrollWidth > wrap.clientWidth;
    return { pageOverflow, wrapOverflow };
  });
  assert.ok(tableCheck.pageOverflow <= 4, `${viewport.name} table wrapper should contain table`);
  assert.equal(
    tableCheck.wrapOverflow,
    !isDesktop && !usesTradeCards,
    `${viewport.name} trade cards should fit phones while the table scrolls only on intermediate widths`
  );

  const tradeControlMetrics = await page.evaluate(() => {
    const table = document.querySelector('#tradeTable');
    const rows = [...table.querySelectorAll('tbody tr')];
    const firstRow = rows[0];
    if (!firstRow) return { available: false };
    const headers = [...table.querySelectorAll('thead th')].map((th) => ({
      text: th.textContent.trim(),
      width: th.getBoundingClientRect().width
    }));
    const controlSelectors = [
      '.trade-time',
      '.trade-name',
      '.trade-side',
      '.trade-price',
      '.trade-detail-toggle > summary',
      '.trade-mode',
      '.trade-reason',
      'select.score'
    ];
    const controls = controlSelectors.flatMap((selector) => (
      [...firstRow.querySelectorAll(selector)].map((el) => {
        const box = el.getBoundingClientRect();
        return { selector, width: box.width, height: box.height };
      })
    ));
    const scoreWidths = [...firstRow.querySelectorAll('select.score')].map((el) => el.getBoundingClientRect().width);
    const scoreHeaderWidths = headers
      .filter((header) => ['计划性', '主线', '风控'].includes(header.text))
      .map((header) => header.width);
    const details = firstRow.querySelector('.trade-detail-toggle');
    const foldedFields = [...firstRow.querySelectorAll('.trade-qty,.trade-amount')]
      .map((el) => el.getBoundingClientRect().height);
    return { available: true, headers, controls, scoreWidths, scoreHeaderWidths, detailsOpen: details.open, foldedFields };
  });
  assert.equal(tradeControlMetrics.available, true, `${viewport.name} trade table should have initial rows`);
  if (!usesTradeCards) {
    const maxScoreHeader = Math.max(...tradeControlMetrics.scoreHeaderWidths);
    const minScoreHeader = Math.min(...tradeControlMetrics.scoreHeaderWidths);
    assert.ok(maxScoreHeader - minScoreHeader <= 2, `${viewport.name} score columns should use equal widths`);
    assert.ok(maxScoreHeader <= 132, `${viewport.name} score columns should not be stretched, width=${maxScoreHeader}`);
    const controlHeights = tradeControlMetrics.controls.map((item) => item.height);
    assert.ok(
      Math.max(...controlHeights) - Math.min(...controlHeights) <= 4,
      `${viewport.name} trade controls should align to one height: ${JSON.stringify(tradeControlMetrics.controls)}`
    );
    const transactionHeader = tradeControlMetrics.headers.find((header) => header.text === '交易');
    assert.ok(transactionHeader && transactionHeader.width >= 200, `${viewport.name} transaction column should fit side and visible price`);
  } else {
    const card = await page.locator('#tradeTable tbody tr:first-child').evaluate((row) => {
      const style = getComputedStyle(row);
      const labels = [...row.querySelectorAll('td')].map((cell) => cell.dataset.label);
      const controls = [...row.querySelectorAll('input,select,textarea,summary,button')]
        .map((element) => element.getBoundingClientRect().height)
        .filter((height) => height > 0);
      return { display: style.display, backgroundColor: style.backgroundColor, labels, controls };
    });
    assert.equal(card.display, 'block', `${viewport.name} should render each trade as a card`);
    assert.notEqual(card.backgroundColor, 'rgba(0, 0, 0, 0)', `${viewport.name} trade cards should be opaque`);
    assert.deepEqual(card.labels, ['时间','股票/ETF','交易','模式','理由','计划性','主线','风控','总分','操作']);
    assert.ok(card.controls.every((height) => height >= 44), `${viewport.name} visible card controls should be at least 44px high`);
  }
  assert.equal(tradeControlMetrics.detailsOpen, false, `${viewport.name} quantity and amount should be folded by default`);
  assert.ok(tradeControlMetrics.foldedFields.every((height) => height === 0), `${viewport.name} folded quantity and amount should not consume row height`);

  await page.locator('#tradeTable tbody tr:first-child .trade-detail-toggle > summary').click();
  const expandedFields = await page.locator('#tradeTable tbody tr:first-child').evaluate((row) => (
    [...row.querySelectorAll('.trade-qty,.trade-amount')].map((el) => {
      const box = el.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })
  ));
  assert.ok(expandedFields.every((field) => field.width > 0 && field.height >= 40), `${viewport.name} quantity and amount should be editable when expanded`);

  const liquidGlass = await page.evaluate(() => {
    const bodyBefore = getComputedStyle(document.body, '::before');
    const bodyAfter = getComputedStyle(document.body, '::after');
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const heroBefore = getComputedStyle(document.querySelector('.hero'), '::before');
    const hero = getComputedStyle(document.querySelector('.hero'));
    const section = getComputedStyle(document.querySelector('.section'));
    const field = getComputedStyle(document.querySelector('.field'));
    const panel = getComputedStyle(document.querySelector('.panel'));
    const tableWrap = getComputedStyle(document.querySelector('.table-wrap'));
    const shell = getComputedStyle(document.querySelector('.shell'));
    return {
      viewportLocked: html.overflowY === 'hidden' && body.overflowY === 'hidden',
      shellScrolls: shell.overflowY === 'auto' && shell.overscrollBehaviorY !== 'auto',
      documentScrolls: html.overflowY !== 'hidden' && body.overflowY !== 'hidden' && shell.overflowY !== 'auto',
      rootHasPageBackground: html.backgroundImage !== 'none' || html.backgroundColor !== 'rgba(0, 0, 0, 0)',
      bodyBackdropVisible: bodyBefore.content !== 'none',
      hasSubtleLiquidBackdrop: bodyBefore.backgroundImage.includes('radial-gradient') && !bodyBefore.backgroundImage.includes('conic-gradient'),
      backdropIsStatic: bodyBefore.animationName === 'none' && bodyAfter.animationName === 'none',
      backdropFilter: bodyBefore.filter,
      heroReflectionRemoved: heroBefore.content === 'none' || heroBefore.display === 'none',
      heroAvoidsTealWash: !hero.backgroundImage.includes('32, 214, 199, 0.28'),
      heroUsesFrostedSurface: hero.backgroundImage.includes('rgba(255, 255, 255'),
      heroBlur: hero.backdropFilter || hero.webkitBackdropFilter || '',
      heroReadableContrast: hero.backgroundImage.includes('rgba(255, 255, 255') || hero.backgroundColor.includes('255, 255, 255'),
      sectionBlur: section.backdropFilter || section.webkitBackdropFilter || '',
      sectionPaintsImmediately: section.contentVisibility !== 'auto',
      shellAvoidsFilter: shell.filter === 'none',
      contentCardBlurRemoved: [section, field, panel, tableWrap].every((style) => {
        const blur = style.backdropFilter || style.webkitBackdropFilter || '';
        return blur === 'none';
      }),
      fieldBackgroundColor: field.backgroundColor,
      sectionBackgroundColor: section.backgroundColor
    };
  });
  assert.equal(liquidGlass.documentScrolls, true, `${viewport.name} should use native document scrolling`);
  assert.equal(liquidGlass.shellAvoidsFilter, true, `${viewport.name} shell should avoid whole-layer filters while scrolling`);
  assert.equal(liquidGlass.contentCardBlurRemoved, true, `${viewport.name} content surfaces should never use live backdrop blur`);
  assert.equal(liquidGlass.rootHasPageBackground, true, `${viewport.name} root should paint a background behind overscroll`);
  assert.equal(liquidGlass.bodyBackdropVisible, true, `${viewport.name} should expose the backdrop layer`);
  assert.equal(liquidGlass.hasSubtleLiquidBackdrop, true, `${viewport.name} should use a restrained liquid backdrop`);
  assert.equal(liquidGlass.backdropIsStatic, true, `${viewport.name} backdrop layers should render without animation`);
  assert.doesNotMatch(liquidGlass.backdropFilter, /hue-rotate/, `${viewport.name} backdrop should not animate expensive color filters`);
  const blurMatch = liquidGlass.backdropFilter.match(/blur\(([\d.]+)px\)/);
  assert.ok(blurMatch && Number(blurMatch[1]) <= 18, `${viewport.name} backdrop blur should stay lightweight`);
  assert.equal(liquidGlass.heroReflectionRemoved, true, `${viewport.name} hero should not render the large reflection overlay`);
  assert.equal(liquidGlass.heroAvoidsTealWash, true, `${viewport.name} hero should avoid the teal wash shown in the screenshot`);
  assert.equal(liquidGlass.heroUsesFrostedSurface, true, `${viewport.name} hero should use a readable frosted surface`);
  assert.match(liquidGlass.heroBlur, /blur/, `${viewport.name} hero should keep liquid-glass blur`);
  assert.equal(liquidGlass.heroReadableContrast, true, `${viewport.name} hero should keep a dark readable glass base`);
  assert.equal(liquidGlass.sectionBlur, 'none', `${viewport.name} sections should remain opaque content surfaces`);
  assert.equal(liquidGlass.sectionPaintsImmediately, true, `${viewport.name} sections should not defer painting during scroll`);
  assert.notEqual(liquidGlass.fieldBackgroundColor, 'rgba(0, 0, 0, 0)', `${viewport.name} fields should be opaque`);
  assert.notEqual(liquidGlass.sectionBackgroundColor, 'rgba(0, 0, 0, 0)', `${viewport.name} sections should be opaque`);
}

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(pageUrl);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator('#rightThing').fill('严格按计划执行');
await page.waitForFunction(() => localStorage.getItem('tradeReviewDataV3')?.includes('严格按计划执行'));
await page.locator('#autosaveStatus').waitFor();
assert.match(await page.locator('#autosaveStatus').textContent(), /已保存到本机/);
await page.reload();
assert.equal(await page.locator('#rightThing').inputValue(), '严格按计划执行', 'today\'s draft should restore automatically after refresh');

await page.setViewportSize({ width: 1366, height: 900 });
await page.goto(pageUrl);
const importButton = page.locator('button', { hasText: '读取最新同花顺数据' }).first();
await importButton.focus();
const focusedButton = await importButton.evaluate((el) => {
  const style = getComputedStyle(el);
  return { boxShadow: style.boxShadow, outline: style.outline, transform: style.transform };
});
assert.doesNotMatch(focusedButton.boxShadow, /0px 0px 0px 5px|34px/, 'focused buttons should not use heavy glow effects');

const box = await importButton.boundingBox();
assert.ok(box, 'import button should be visible for interaction check');
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
const pressedScale = await importButton.evaluate((el) => {
  const transform = getComputedStyle(el).transform;
  if (transform === 'none') return { x: 1, y: 1 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.a, y: matrix.d };
});
await page.mouse.up();
assert.ok(pressedScale.x <= 1.01 && pressedScale.y <= 1.01, 'pressed buttons should not scale up');

const liquidKeyframes = await page.evaluate(() => {
  for (const sheet of [...document.styleSheets]) {
    for (const rule of [...sheet.cssRules]) {
      if (rule.name === 'liquidBackdrop') return rule.cssText;
    }
  }
  return '';
});
assert.equal(liquidKeyframes, '', 'liquid backdrop animation should be removed for smoother scrolling');

await browser.close();
console.log('PASS responsive layout');
