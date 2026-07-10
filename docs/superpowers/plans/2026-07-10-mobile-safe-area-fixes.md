# Mobile Safe-Area Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the mobile date input inside its card, make the up-arrow scroll the real mobile container, and extend the page surface to the iPhone safe-area boundary.

**Architecture:** Preserve the current split scrolling model: desktop scrolls the document and mobile scrolls `.shell`. Add mobile-only viewport and safe-area CSS, route the floating control through one scroll helper that selects the correct container, and verify both modes with the existing Playwright responsive suite.

**Tech Stack:** Single-file HTML/CSS/JavaScript, Playwright, Node.js test runner, OpenAI Sites deployment.

---

### Task 1: Add failing mobile regression coverage

**Files:**
- Modify: `tests/layout-responsive.test.mjs`

- [ ] **Step 1: Add mobile date and viewport assertions**

Inside the viewport loop, collect the date input, containing field, shell bounds, and computed styles:

```js
const mobileViewportMetrics = await page.evaluate(() => {
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
    shellBottomGap: Math.abs(window.innerHeight - shellBox.bottom)
  };
});
```

For non-desktop viewports, assert:

```js
assert.equal(mobileViewportMetrics.dateInsideField, true, `${viewport.name} date input should stay inside its field`);
assert.equal(mobileViewportMetrics.dateAppearance, 'none', `${viewport.name} date input should normalize iOS appearance`);
assert.equal(mobileViewportMetrics.shellPosition, 'fixed', `${viewport.name} shell should cover the visual viewport`);
assert.ok(mobileViewportMetrics.shellBottomGap <= 1, `${viewport.name} shell should reach the viewport bottom`);
```

- [ ] **Step 2: Add scroll-to-top interaction coverage**

After the existing mobile scroll assertion, click `.fab` and wait for the mobile shell to return to zero:

```js
await page.locator('.fab').click();
await page.waitForFunction(() => document.querySelector('.shell').scrollTop === 0);
```

For desktop, scroll the document, click `.fab`, and wait for `window.scrollY === 0`.

- [ ] **Step 3: Run the responsive test and verify RED**

Run:

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/layout-responsive.test.mjs
```

Expected: FAIL because the mobile shell is `position: relative`, the date input keeps native appearance, and clicking the arrow does not reset `.shell.scrollTop`.

### Task 2: Implement the mobile layout and interaction fixes

**Files:**
- Modify: `index.html`
- Test: `tests/layout-responsive.test.mjs`

- [ ] **Step 1: Constrain the iOS date input**

Add targeted CSS after the shared input rules:

```css
input[type="date"]{
  appearance:none;
  -webkit-appearance:none;
  display:block;
  inline-size:100%;
  min-inline-size:0;
  max-inline-size:100%;
  overflow:hidden;
}
input[type="date"]::-webkit-date-and-time-value{
  min-width:0;
  text-align:left;
}
```

- [ ] **Step 2: Make the mobile shell fill the safe visual viewport**

Extend the existing mobile media rules:

```css
@media(max-width:980px){
  .shell{
    position:fixed;
    inset:0;
    width:100%;
    max-width:none;
    height:auto;
    min-height:0;
    padding-bottom:calc(18px + env(safe-area-inset-bottom));
  }
  .floating{
    right:max(12px, env(safe-area-inset-right));
    bottom:calc(12px + env(safe-area-inset-bottom));
  }
}
```

In the `max-width:620px` rule, preserve the safe-area bottom padding:

```css
.shell{padding:10px 8px calc(12px + env(safe-area-inset-bottom))}
```

- [ ] **Step 3: Route the up-arrow to the active scroll container**

Replace the anchor with:

```html
<button type="button" class="fab" aria-label="回到顶部" title="回到顶部" onclick="scrollReviewToTop()">↑</button>
```

Add button reset styles to `.fab`:

```css
padding:0;
border:0;
min-height:52px;
line-height:1;
cursor:pointer;
```

Add this function near the start of the page script:

```js
function scrollReviewToTop(){
  const shell = document.querySelector('.shell');
  const mobileShellScrolls = window.matchMedia('(max-width: 980px)').matches;
  if(mobileShellScrolls && shell){
    shell.scrollTo({top:0,behavior:'smooth'});
    return;
  }
  window.scrollTo({top:0,behavior:'smooth'});
}
```

- [ ] **Step 4: Run the responsive test and verify GREEN**

Run:

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/layout-responsive.test.mjs
```

Expected: `PASS responsive layout`.

- [ ] **Step 5: Commit the implementation**

```bash
git add index.html tests/layout-responsive.test.mjs
git commit -m "fix: refine mobile viewport controls"
```

### Task 3: Verify and publish local and online builds

**Files:**
- Verify: `index.html`
- Generated and ignored: `dist/**`

- [ ] **Step 1: Run the complete test suite**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/run-all.mjs
```

Expected: all 15 test files pass.

- [ ] **Step 2: Build the cloud site**

```bash
/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tools/build-cloud-site.mjs
```

Expected: `Built dist/server/index.js`.

- [ ] **Step 3: Push the verified commit to GitHub**

Run from the feature branch created for this change:

```bash
git push -u origin fix/mobile-safe-area
gh pr create --repo lukesestevens-commits/stock-review --base main --head fix/mobile-safe-area --title "Fix mobile safe-area layout and controls" --body "Fixes the iOS date field width, scroll-to-top behavior, and full-screen safe-area coverage. Verified with the complete test suite and cloud build."
gh pr merge --repo lukesestevens-commits/stock-review --merge --delete-branch
```

Expected: the pull request is merged into GitHub `main`.

- [ ] **Step 4: Save and deploy the exact commit with Sites**

Push the exact commit to the existing Sites source repository, package it with:

```bash
/Users/ruiqiwang/.codex/plugins/cache/openai-bundled/sites/0.1.27/scripts/package-site.sh "$PWD" /tmp/tzzb-mobile-safe-area.tar.gz
```

Use the existing Sites project ID from `.openai/hosting.json`. Create a short-lived source write credential, push the exact feature commit to the Sites `main` branch, call `save_site_version` with the full commit SHA and `/tmp/tzzb-mobile-safe-area.tar.gz`, then deploy the returned version with `deploy_site_version`. Poll `get_deployment_status` until it returns `succeeded`.

- [ ] **Step 5: Verify production behavior**

Confirm the production root returns HTTP 200, the deployed HTML contains `scrollReviewToTop`, and the responsive Playwright test passes against the final source. Report the production URL and merged pull request.
