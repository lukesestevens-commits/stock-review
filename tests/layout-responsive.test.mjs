import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const pageUrl = new URL('../index.html', import.meta.url).href;
const colorLuminance = (color) => {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
  assert.equal(channels.length, 3, `expected an RGB color, received ${color}`);
  const linear = channels.map((value) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
};
const viewports = [
  { name: 'wide desktop', width: 1920, height: 1080 },
  { name: 'large desktop', width: 1440, height: 900 },
  { name: 'desktop', width: 1366, height: 900 },
  { name: 'compact table boundary', width: 1120, height: 820 },
  { name: 'card boundary', width: 1119, height: 820 },
  { name: 'compact desktop card', width: 1024, height: 768 },
  { name: 'wide card boundary', width: 900, height: 760 },
  { name: 'narrow card boundary', width: 899, height: 760 },
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'mobile landscape', width: 844, height: 390 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'legacy breakpoint edge', width: 621, height: 900 },
  { name: 'small phone', width: 360, height: 800 },
  { name: 'minimum phone', width: 320, height: 720 }
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
  const usesTradeCards = viewport.width <= 1119;
  const usesHoldingCards = viewport.width <= 1119;
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

  if (viewport.width >= 1280) {
    await page.locator('.fab').click();
  } else {
    assert.equal(await page.locator('.fab').isVisible(), false, `${viewport.name} fixed FAB should stay hidden so it cannot cover review controls`);
    await page.evaluate(() => scrollReviewToTop());
  }
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
    const wrapOverflow = wrap.scrollWidth - wrap.clientWidth;
    const tableBox = table.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const tableWithinWrap = tableBox.left >= wrapBox.left - 1 && tableBox.right <= wrapBox.right + 1;
    return { pageOverflow, wrapOverflow, tableWithinWrap };
  });
  assert.ok(tableCheck.pageOverflow <= 4, `${viewport.name} table wrapper should contain table`);
  assert.ok(tableCheck.wrapOverflow <= 1, `${viewport.name} trade table should never require horizontal scrolling, overflow=${tableCheck.wrapOverflow}`);
  assert.equal(tableCheck.tableWithinWrap, true, `${viewport.name} trade table should stay inside its wrapper`);

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
    const visibleControls = [...firstRow.querySelectorAll('input,select,textarea,summary,button')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    const escapedControls = visibleControls.filter((element) => {
      const cell = element.closest('td');
      if (!cell) return false;
      const box = element.getBoundingClientRect();
      const boundary = cell.getBoundingClientRect();
      return box.left < boundary.left - 1 || box.right > boundary.right + 1
        || box.top < boundary.top - 1 || box.bottom > boundary.bottom + 1;
    }).map((element) => element.className || element.tagName);
    const overlaps = [];
    for (let i = 0; i < visibleControls.length; i += 1) {
      for (let j = i + 1; j < visibleControls.length; j += 1) {
        const a = visibleControls[i];
        const b = visibleControls[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const overlapWidth = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
        const overlapHeight = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
        if (overlapWidth > 1 && overlapHeight > 1) {
          overlaps.push(`${a.className || a.tagName} / ${b.className || b.tagName}`);
        }
      }
    }
    return {
      available: true,
      headers,
      controls,
      scoreWidths,
      scoreHeaderWidths,
      detailsOpen: details.open,
      foldedFields,
      escapedControls,
      overlaps,
      rowHeight: firstRow.getBoundingClientRect().height
    };
  });
  assert.equal(tradeControlMetrics.available, true, `${viewport.name} trade table should have initial rows`);
  assert.deepEqual(tradeControlMetrics.escapedControls, [], `${viewport.name} trade controls should stay inside their cells`);
  assert.deepEqual(tradeControlMetrics.overlaps, [], `${viewport.name} trade controls should never overlap`);
  if (!usesTradeCards) {
    assert.deepEqual(
      tradeControlMetrics.headers.map((header) => header.text),
      ['时间', '股票/ETF', '成交', '复盘', '交易质量', '操作'],
      `${viewport.name} should expose the compact six-column header`
    );
    const controlHeights = tradeControlMetrics.controls.map((item) => item.height);
    assert.ok(
      Math.max(...controlHeights) - Math.min(...controlHeights) <= 8,
      `${viewport.name} trade controls should align to one height: ${JSON.stringify(tradeControlMetrics.controls)}`
    );
    const transactionHeader = tradeControlMetrics.headers.find((header) => header.text === '成交');
    assert.ok(transactionHeader && transactionHeader.width >= 220, `${viewport.name} transaction column should fit side, price and compact details`);
    assert.ok(tradeControlMetrics.rowHeight <= 88, `${viewport.name} collapsed trade rows should stay compact, height=${tradeControlMetrics.rowHeight}`);
  } else {
    const card = await page.locator('#tradeTable tbody tr:first-child').evaluate((row) => {
      const style = getComputedStyle(row);
      const labels = [...row.querySelectorAll('td')].map((cell) => cell.dataset.label);
      const controls = [...row.querySelectorAll('input,select,textarea,summary,button')]
        .map((element) => element.getBoundingClientRect().height)
        .filter((height) => height > 0);
      return { display: style.display, backgroundColor: style.backgroundColor, labels, controls, height: row.getBoundingClientRect().height };
    });
    assert.equal(card.display, 'grid', `${viewport.name} should render each trade as a grid card`);
    assert.notEqual(card.backgroundColor, 'rgba(0, 0, 0, 0)', `${viewport.name} trade cards should be opaque`);
    assert.deepEqual(card.labels, ['时间','股票/ETF','成交','复盘','交易质量','操作']);
    assert.ok(card.controls.every((height) => height >= 44), `${viewport.name} visible card controls should be at least 44px high`);
    if (viewport.width <= 480) {
      assert.ok(card.height <= 360, `${viewport.name} trade cards should stay compact, height=${card.height}`);
    }
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
  const expandedGeometry = await page.locator('#tradeTable tbody tr:first-child').evaluate((row) => {
    const wrap = row.closest('.trade-table-wrap');
    const rowBox = row.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const escaped = [...row.querySelectorAll('input,select,textarea,summary,button')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        return box.left < rowBox.left - 1 || box.right > rowBox.right + 1;
      }).map((element) => element.className || element.tagName);
    const nextRow = row.nextElementSibling;
    return {
      escaped,
      wrapOverflow: wrap.scrollWidth - wrap.clientWidth,
      rowWithinWrap: rowBox.left >= wrapBox.left - 1 && rowBox.right <= wrapBox.right + 1,
      nextRowSeparated: !nextRow || rowBox.bottom <= nextRow.getBoundingClientRect().top + 1
    };
  });
  assert.deepEqual(expandedGeometry.escaped, [], `${viewport.name} expanded trade controls should stay inside the row`);
  assert.ok(expandedGeometry.wrapOverflow <= 1, `${viewport.name} expanded trade details should not create horizontal scrolling`);
  assert.equal(expandedGeometry.rowWithinWrap, true, `${viewport.name} expanded row should stay inside the wrapper`);
  assert.equal(expandedGeometry.nextRowSeparated, true, `${viewport.name} expanded row should not overlap the next trade`);

  await page.evaluate(() => {
    const hasHolding = [...document.querySelectorAll('#holdingBody tr')]
      .some((row) => !row.classList.contains('holding-empty'));
    if (!hasHolding) {
      addHoldingReviewRow({
        name: '测试持仓',
        code: '000001',
        value: '10000',
        weight: '10%',
        isCore: '待判断',
        logic: '逻辑待复盘',
        tomorrowAction: '观察',
        trigger: '按计划执行'
      });
    }
  });

  const holdingLayout = await page.locator('#holdingTable tbody tr:not(.holding-empty)').first().evaluate((row) => {
    const table = row.closest('#holdingTable');
    const wrap = table.closest('.holding-table-wrap');
    const rowBox = row.getBoundingClientRect();
    const wrapBox = wrap?.getBoundingClientRect();
    const visibleControls = [...row.querySelectorAll('input,select,textarea,button')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    const escapedControls = visibleControls.filter((element) => {
      const box = element.getBoundingClientRect();
      return box.left < rowBox.left - 1 || box.right > rowBox.right + 1
        || box.top < rowBox.top - 1 || box.bottom > rowBox.bottom + 1;
    }).map((element) => element.className || element.tagName);
    const overlaps = [];
    for (let i = 0; i < visibleControls.length; i += 1) {
      for (let j = i + 1; j < visibleControls.length; j += 1) {
        const a = visibleControls[i].getBoundingClientRect();
        const b = visibleControls[j].getBoundingClientRect();
        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapWidth > 1 && overlapHeight > 1) {
          overlaps.push(`${visibleControls[i].className || visibleControls[i].tagName} / ${visibleControls[j].className || visibleControls[j].tagName}`);
        }
      }
    }
    const core = row.querySelector('.holding-core')?.getBoundingClientRect();
    const action = row.querySelector('.holding-action')?.getBoundingClientRect();
    return {
      rowDisplay: getComputedStyle(row).display,
      labels: [...row.querySelectorAll('td')].map((cell) => cell.dataset.label),
      wrapFound: Boolean(wrap),
      wrapOverflow: wrap ? wrap.scrollWidth - wrap.clientWidth : Number.POSITIVE_INFINITY,
      tableOverflow: table.scrollWidth - table.clientWidth,
      rowWithinWrap: Boolean(wrapBox)
        && rowBox.left >= wrapBox.left - 1
        && rowBox.right <= wrapBox.right + 1,
      escapedControls,
      overlaps,
      coreWidth: core?.width || 0,
      actionWidth: action?.width || 0
    };
  });
  assert.equal(holdingLayout.wrapFound, true, `${viewport.name} holdings should use their dedicated responsive wrapper`);
  assert.ok(
    holdingLayout.wrapOverflow <= 1,
    `${viewport.name} holdings should never require internal horizontal scrolling, overflow=${holdingLayout.wrapOverflow}`
  );
  assert.ok(
    holdingLayout.tableOverflow <= 1,
    `${viewport.name} holding table should fit its own responsive box, overflow=${holdingLayout.tableOverflow}`
  );
  assert.equal(holdingLayout.rowWithinWrap, true, `${viewport.name} holding rows should stay inside their wrapper`);
  assert.deepEqual(holdingLayout.escapedControls, [], `${viewport.name} holding controls should stay inside their card or row`);
  assert.deepEqual(holdingLayout.overlaps, [], `${viewport.name} holding controls should never overlap`);
  if (usesHoldingCards) {
    assert.equal(holdingLayout.rowDisplay, 'grid', `${viewport.name} should render each holding as a grid card`);
    assert.deepEqual(
      holdingLayout.labels,
      ['股票/ETF', '市值 / 仓位', '是否核心', '明日处理', '持仓逻辑', '触发条件', '操作'],
      `${viewport.name} holding cards should expose a clear top-to-bottom field order`
    );
    if (viewport.width <= 621) {
      assert.ok(holdingLayout.coreWidth > 0 && holdingLayout.actionWidth > 0, `${viewport.name} paired holding selects should be visible`);
      assert.ok(
        Math.abs(holdingLayout.coreWidth - holdingLayout.actionWidth) <= 1,
        `${viewport.name} paired holding selects should share equal widths: core=${holdingLayout.coreWidth}, action=${holdingLayout.actionWidth}`
      );
    }
  } else {
    assert.equal(holdingLayout.rowDisplay, 'table-row', `${viewport.name} should keep the compact holding table at 1120px and wider`);
  }

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
      sectionBackgroundColor: section.backgroundColor,
      fieldBorderColor: field.borderColor,
      sectionBorderColor: section.borderColor
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
  assert.notEqual(
    liquidGlass.sectionBackgroundColor,
    liquidGlass.fieldBackgroundColor,
    `${viewport.name} outer sections should use a darker surface than inner fields`
  );
  assert.ok(
    colorLuminance(liquidGlass.sectionBackgroundColor) < colorLuminance(liquidGlass.fieldBackgroundColor),
    `${viewport.name} outer section surface should be darker than the inner field surface`
  );
  assert.notEqual(
    liquidGlass.sectionBorderColor,
    liquidGlass.fieldBorderColor,
    `${viewport.name} outer section borders should be visually distinct from inner field borders`
  );
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
