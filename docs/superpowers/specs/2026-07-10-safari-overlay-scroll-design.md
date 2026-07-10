# Safari Overlay Scrolling Design

## Goal

Make the mobile review page behave like a normal long Safari document so Safari's translucent top status area and bottom toolbar can float over webpage content instead of sitting above opaque page gaps.

## Current Behavior

The mobile layout locks `html` and `body`, fixes `.shell` to the visual viewport, and assigns vertical scrolling to `.shell`. This keeps the application inside Safari's unobscured viewport. On Safari 26, fixed viewport content does not continue rendering behind the floating browser controls, so the top and bottom regions appear as separate masks.

## Design

### Native Mobile Document Scrolling

At widths up to 980 px, restore native document scrolling:

- `html` and `body` use automatic height and vertical scrolling.
- `.shell` becomes a normal relative document element with automatic height and visible overflow.
- The document background remains on both `html` and `body`, allowing Safari's translucent controls to reveal the webpage surface beneath them.
- The page keeps enough minimum height to cover the visual viewport when content is short.

Desktop already uses native document scrolling and remains unchanged.

### Safe Areas

Keep `viewport-fit=cover` and the four `safe-area-inset-*` values. Important content remains padded away from the Dynamic Island, rounded corners, and Home indicator, while the page background itself continues edge to edge.

The floating up-arrow stays above the bottom safe area so Safari's toolbar does not hide it.

### Scroll-To-Top

The up-arrow scrolls `window` in both mobile and desktop layouts. The page no longer branches on viewport width because `.shell` is no longer a mobile scroll container.

## Browser Scope

This is a standard Safari webpage, not a PWA or installed Home Screen application. Safari's status icons and bottom toolbar remain visible. Their transparency and collapse animation are controlled by Safari; the website supplies continuous content and background beneath them.

## Testing

Update the Chromium responsive and WebKit mobile tests to verify:

- Mobile `window` owns vertical scrolling and `.shell` does not.
- Mobile `.shell` is relative, uses automatic height, and participates in normal document flow.
- Clicking the up-arrow returns `window.scrollY` to zero in portrait and landscape.
- `viewport-fit=cover`, all safe-area declarations, and the edge-to-edge root background remain present.
- Date input containment, horizontal overflow, desktop scrolling, and existing application behavior remain unchanged.

## Scope

Do not add a manifest, service worker, installation prompt, standalone mode, or custom browser chrome. Do not change data synchronization, colors, cards, or desktop composition.
