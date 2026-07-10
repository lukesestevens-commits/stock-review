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

for (const viewport of viewports) {
  const isDesktop = viewport.width >= 981;
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(pageUrl);
  await page.locator('text=今日复盘工作台').waitFor();

  const scrollability = await page.evaluate(() => ({
    windowScrollHeight: document.documentElement.scrollHeight,
    windowClientHeight: document.documentElement.clientHeight,
    shellScrollHeight: document.querySelector('.shell').scrollHeight,
    shellClientHeight: document.querySelector('.shell').clientHeight,
    initialWindowY: window.scrollY,
    initialShellY: document.querySelector('.shell').scrollTop
  }));
  if (isDesktop) {
    assert.ok(
      scrollability.windowScrollHeight > scrollability.windowClientHeight + 200,
      `${viewport.name} browser viewport should own vertical scrolling`
    );
    await page.evaluate(() => window.scrollTo(0, 500));
  } else {
    assert.ok(
      scrollability.shellScrollHeight > scrollability.shellClientHeight + 200,
      `${viewport.name} shell should have enough vertical content to scroll`
    );
    await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      shell.scrollTop = 500;
    });
  }
  const scrolled = await page.evaluate(() => ({
    windowY: window.scrollY,
    shellY: document.querySelector('.shell').scrollTop
  }));
  if (isDesktop) {
    assert.ok(scrolled.windowY > scrollability.initialWindowY, `${viewport.name} browser viewport should scroll vertically`);
    assert.equal(scrolled.shellY, scrollability.initialShellY, `${viewport.name} shell should not be the desktop scroll container`);
    await page.evaluate(() => window.scrollTo(0, 0));
  } else {
    assert.equal(scrolled.windowY, scrollability.initialWindowY, `${viewport.name} browser viewport should stay fixed`);
    assert.ok(scrolled.shellY > scrollability.initialShellY, `${viewport.name} shell should scroll vertically`);
    await page.evaluate(() => { document.querySelector('.shell').scrollTop = 0; });
  }

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

  const tableCheck = await page.evaluate(() => {
    const table = document.querySelector('#tradeTable');
    const wrap = table.closest('.table-wrap');
    const pageOverflow = wrap.getBoundingClientRect().right - document.documentElement.getBoundingClientRect().right;
    const wrapOverflow = table.scrollWidth > wrap.clientWidth;
    return { pageOverflow, wrapOverflow };
  });
  assert.ok(tableCheck.pageOverflow <= 4, `${viewport.name} table wrapper should contain table`);
  assert.equal(tableCheck.wrapOverflow, true, `${viewport.name} trade table should scroll inside its wrapper`);

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
      '.trade-amount',
      '.trade-detail-toggle',
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
    return { available: true, headers, controls, scoreWidths, scoreHeaderWidths };
  });
  assert.equal(tradeControlMetrics.available, true, `${viewport.name} trade table should have initial rows`);
  const maxScoreHeader = Math.max(...tradeControlMetrics.scoreHeaderWidths);
  const minScoreHeader = Math.min(...tradeControlMetrics.scoreHeaderWidths);
  assert.ok(maxScoreHeader - minScoreHeader <= 2, `${viewport.name} score columns should use equal widths`);
  assert.ok(maxScoreHeader <= 132, `${viewport.name} score columns should not be stretched, width=${maxScoreHeader}`);
  const controlHeights = tradeControlMetrics.controls.map((item) => item.height);
  assert.ok(
    Math.max(...controlHeights) - Math.min(...controlHeights) <= 4,
    `${viewport.name} trade controls should align to one height: ${JSON.stringify(tradeControlMetrics.controls)}`
  );
  const detail = tradeControlMetrics.controls.find((item) => item.selector === '.trade-detail-toggle');
  const amount = tradeControlMetrics.controls.find((item) => item.selector === '.trade-amount');
  assert.ok(detail && amount && Math.abs(detail.width - amount.width) <= 8, `${viewport.name} detail button should match input width`);

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
      hasImmersiveColorMix: bodyBefore.backgroundImage.includes('conic-gradient') && bodyBefore.backgroundImage.includes('radial-gradient'),
      backdropIsStatic: bodyBefore.animationName === 'none' && bodyAfter.animationName === 'none',
      backdropFilter: bodyBefore.filter,
      heroReflectionRemoved: heroBefore.content === 'none' || heroBefore.display === 'none',
      heroAvoidsTealWash: !hero.backgroundImage.includes('32, 214, 199, 0.28'),
      heroUsesLightPurple: hero.backgroundImage.includes('230, 214, 255') || hero.backgroundImage.includes('213, 188, 255'),
      heroBlur: hero.backdropFilter || hero.webkitBackdropFilter || '',
      heroReadableContrast: hero.backgroundImage.includes('rgba(255, 255, 255') || hero.backgroundColor.includes('255, 255, 255'),
      sectionBlur: section.backdropFilter || section.webkitBackdropFilter || '',
      sectionPaintsImmediately: section.contentVisibility !== 'auto',
      shellAvoidsFilter: shell.filter === 'none',
      desktopCardBlurRemoved: [section, field, panel, tableWrap].every((style) => {
        const blur = style.backdropFilter || style.webkitBackdropFilter || '';
        return blur === 'none';
      }),
      fieldBackground: field.backgroundImage
    };
  });
  if (isDesktop) {
    assert.equal(liquidGlass.documentScrolls, true, `${viewport.name} should use native document scrolling`);
    assert.equal(liquidGlass.shellAvoidsFilter, true, `${viewport.name} shell should avoid whole-layer filters while scrolling`);
    assert.equal(liquidGlass.desktopCardBlurRemoved, true, `${viewport.name} form surfaces should avoid live backdrop blur during scroll`);
  } else {
    assert.equal(liquidGlass.viewportLocked, true, `${viewport.name} viewport should not rubber-band the whole document`);
    assert.equal(liquidGlass.shellScrolls, true, `${viewport.name} shell should be the contained scroll area`);
  }
  assert.equal(liquidGlass.rootHasPageBackground, true, `${viewport.name} root should paint a background behind overscroll`);
  assert.equal(liquidGlass.bodyBackdropVisible, true, `${viewport.name} should expose the backdrop layer`);
  assert.equal(liquidGlass.hasImmersiveColorMix, true, `${viewport.name} should use a colorful immersive liquid color mix`);
  assert.equal(liquidGlass.backdropIsStatic, true, `${viewport.name} backdrop layers should render without animation`);
  assert.doesNotMatch(liquidGlass.backdropFilter, /hue-rotate/, `${viewport.name} backdrop should not animate expensive color filters`);
  const blurMatch = liquidGlass.backdropFilter.match(/blur\(([\d.]+)px\)/);
  assert.ok(blurMatch && Number(blurMatch[1]) <= 18, `${viewport.name} backdrop blur should stay lightweight`);
  assert.equal(liquidGlass.heroReflectionRemoved, true, `${viewport.name} hero should not render the large reflection overlay`);
  assert.equal(liquidGlass.heroAvoidsTealWash, true, `${viewport.name} hero should avoid the teal wash shown in the screenshot`);
  assert.equal(liquidGlass.heroUsesLightPurple, true, `${viewport.name} hero should use a light purple gradient`);
  if (!isDesktop) {
    assert.match(liquidGlass.heroBlur, /blur/, `${viewport.name} hero should use glass blur`);
  }
  assert.equal(liquidGlass.heroReadableContrast, true, `${viewport.name} hero should keep a dark readable glass base`);
  if (!isDesktop) {
    assert.match(liquidGlass.sectionBlur, /blur/, `${viewport.name} sections should use glass blur`);
  }
  assert.equal(liquidGlass.sectionPaintsImmediately, true, `${viewport.name} sections should not defer painting during scroll`);
  assert.match(liquidGlass.fieldBackground, /linear-gradient|rgba/, `${viewport.name} fields should keep translucent glass styling`);
}

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
