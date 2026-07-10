# Mobile Date, Scroll-To-Top, and Safe-Area Fixes

## Goal

Fix three mobile-only usability problems without changing the desktop layout:

1. Keep the review date input inside its field card on iOS browsers.
2. Make the floating up-arrow scroll the actual mobile content container to the top.
3. Extend the page surface to the full visual viewport while keeping content and the floating button clear of the iPhone Home indicator.

## Current Behavior

The mobile layout locks document scrolling and makes `.shell` the vertical scroll container. The date input can retain an iOS native minimum width and escape its field card. The up-arrow calls `window.scrollTo`, which does not move `.shell`. The `.shell` height can end above the visible browser viewport, leaving a separate background strip near the bottom.

## Design

### Date Input

Add a targeted `input[type="date"]` rule with block sizing, zero minimum inline size, full available width, and iOS appearance normalization. Constrain the WebKit date value area so native date text cannot force the input wider than its parent.

### Scroll-To-Top Control

Replace the inline `window.scrollTo` behavior with a named `scrollReviewToTop()` function. On mobile, it scrolls `.shell`; on desktop, it scrolls `window`. Keep smooth scrolling and use a semantic button with an accessible label.

### Full-Screen Bottom Surface

For viewports up to 980 px, make `.shell` a fixed, inset-zero scrolling surface so it covers the complete visual viewport. Preserve the existing locked `html` and `body` behavior. Add `env(safe-area-inset-bottom)` to the shell padding and floating control position so the background reaches the bottom while interactive content stays above the Home indicator.

Desktop keeps native document scrolling and the existing page dimensions.

## Testing

Extend the responsive Playwright test to verify:

- The date input remains within its field card on mobile portrait and landscape viewports.
- The mobile shell reaches the viewport bottom without a visible layout gap.
- Clicking the up-arrow after scrolling `.shell` returns `.shell.scrollTop` to zero.
- Desktop still uses `window` scrolling and the up-arrow returns the document to the top.
- Existing horizontal overflow and responsive layout assertions continue to pass.

## Scope

This change only affects the review date control, floating scroll-to-top control, and mobile viewport/safe-area layout. It does not change data synchronization, review form behavior, colors, card styling, or desktop layout.
