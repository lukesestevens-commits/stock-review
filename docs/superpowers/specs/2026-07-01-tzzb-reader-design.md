# TZZB Reader Design

## Goal

Build a local read-only data reader for the Tonghuashun Investment Ledger page at:

`https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/gcQSW6A`

The user will log in manually in a browser. The reader will observe and reuse the already authenticated browser session to extract account, asset, position, and profit data exposed by the page's own read-only requests.

## Boundaries

- Do not bypass login, captcha, device checks, or other access controls.
- Do not ask the user to provide a password.
- Do not create, edit, delete, import, or upload account data.
- Do not store credentials in project files.
- Prefer browser-session access over manually copying cookies.

## Approach

1. Open the target page in a controllable browser.
2. Let the user complete login manually.
3. Capture the page's network requests after login.
4. Identify read-only endpoints for account lists, positions, asset trends, and related summary data.
5. Build a local script that calls only confirmed read-only endpoints using the active browser session when possible.
6. Save extracted data locally as JSON first; CSV export can be added after the response shapes are known.

## Fallbacks

If direct endpoint calls require browser-only dynamic signing or strict runtime checks, use browser-side extraction instead:

- evaluate page-visible state,
- intercept completed response bodies in the browser,
- or export visible tables from the rendered page.

If the site blocks automation entirely, stop and report what was discoverable without attempting to bypass controls.

## Success Criteria

- User logs in manually.
- At least one authenticated read-only data source is captured.
- Extracted data is saved locally in a clear file format.
- The final workflow can be repeated without exposing the user's password.
