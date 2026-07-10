# Safari Overlay Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore native mobile document scrolling so Safari can render the review page beneath its translucent top and bottom controls.

**Architecture:** Keep the existing edge-to-edge background and safe-area padding, but remove the mobile fixed `.shell` scroll surface. Both mobile and desktop use `window` as the scroll owner, while `.shell` becomes a normal document-flow wrapper.

**Tech Stack:** Single-file HTML/CSS/JavaScript, Node.js, Playwright Chromium, Playwright WebKit, OpenAI Sites.

---

### Task 1: Add failing native-scroll regression tests

**Files:**
- Modify: `tests/layout-responsive.test.mjs`
- Modify: `tests/mobile-webkit.test.mjs`

- [ ] **Step 1: Change responsive scroll ownership expectations**

For every viewport, require document scrolling and reject a mobile `.shell` scroll container:

```js
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
```

Update the computed-style assertions so mobile requires `.shell` to be `position: relative`, not fixed, and requires native document scrolling.

- [ ] **Step 2: Change WebKit scroll expectations**

In `tests/mobile-webkit.test.mjs`, assert:

```js
assert.equal(metrics.shellPosition, 'relative');
assert.equal(metrics.documentScrolls, true);
```

Scroll and verify the document rather than `.shell`:

```js
await page.evaluate(() => window.scrollTo(0, 700));
assert.ok(await page.evaluate(() => window.scrollY) > 0);
await page.getByRole('button', { name: '回到顶部' }).click();
await page.waitForFunction(() => window.scrollY === 0);
```

- [ ] **Step 3: Run both layout tests and verify RED**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/layout-responsive.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/mobile-webkit.test.mjs
```

Expected: FAIL because mobile still locks `html` and `body`, fixes `.shell`, and scrolls `.shell`.

### Task 2: Restore Safari native document scrolling

**Files:**
- Modify: `index.html`
- Test: `tests/layout-responsive.test.mjs`
- Test: `tests/mobile-webkit.test.mjs`

- [ ] **Step 1: Override the mobile root scrolling model**

Inside the `max-width:980px` media block, add:

```css
html,
body{
  height:auto;
  min-height:100%;
  overflow-x:hidden;
  overflow-y:auto;
  overscroll-behavior-y:auto;
}
body{
  min-height:100vh;
  min-height:100dvh;
}
```

- [ ] **Step 2: Return `.shell` to normal document flow**

Replace the mobile fixed-shell properties with:

```css
.shell{
  position:relative;
  inset:auto;
  width:100%;
  max-width:none;
  height:auto;
  min-height:100vh;
  min-height:100dvh;
  overflow:visible;
  overscroll-behavior-y:auto;
  scrollbar-gutter:auto;
  filter:none;
  padding:
    calc(14px + env(safe-area-inset-top))
    calc(clamp(10px,1.8vw,22px) + env(safe-area-inset-right))
    calc(18px + env(safe-area-inset-bottom))
    calc(clamp(10px,1.8vw,22px) + env(safe-area-inset-left));
}
```

- [ ] **Step 3: Make scroll-to-top always use the document**

Replace `scrollReviewToTop()` with:

```js
function scrollReviewToTop(){
  window.scrollTo({top:0,behavior:'smooth'});
}
```

- [ ] **Step 4: Run Chromium and WebKit tests and verify GREEN**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/layout-responsive.test.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/mobile-webkit.test.mjs
```

Expected: `PASS responsive layout` and `PASS mobile WebKit layout`.

- [ ] **Step 5: Commit the implementation**

```bash
git add index.html tests/layout-responsive.test.mjs tests/mobile-webkit.test.mjs
git commit -m "fix: use native Safari page scrolling"
```

### Task 3: Verify and publish

**Files:**
- Verify: `index.html`
- Generated and ignored: `dist/**`

- [ ] **Step 1: Run the complete suite and cloud build**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/run-all.mjs
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tools/build-cloud-site.mjs
```

Expected: all 16 test files pass and `Built dist/server/index.js`.

- [ ] **Step 2: Push and merge the GitHub pull request**

```bash
git push -u origin fix/safari-overlay-scroll
gh pr create --repo lukesestevens-commits/stock-review --base main --head fix/safari-overlay-scroll --title "Use native Safari overlay scrolling" --body "Restores native mobile document scrolling so Safari can display webpage content beneath its translucent browser controls. Verified in Chromium and WebKit."
gh pr merge --repo lukesestevens-commits/stock-review --merge --delete-branch
```

- [ ] **Step 3: Deploy the exact commit to Sites**

Build the archive with:

```bash
/Users/ruiqiwang/.codex/plugins/cache/openai-bundled/sites/0.1.27/scripts/package-site.sh "$PWD" /tmp/tzzb-safari-overlay-scroll.tar.gz
```

Push the exact commit to the existing Sites source repository, save a new version with the full SHA and archive, deploy it to the existing public site, and poll until `succeeded`.

- [ ] **Step 4: Verify local and production HTML**

Confirm local and production roots return HTTP 200 and contain `viewport-fit=cover`, native mobile scrolling styles, safe-area declarations, and the simplified `scrollReviewToTop()` function. Confirm GitHub PR state is `MERGED`.
