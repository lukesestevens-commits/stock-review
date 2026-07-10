# TZZB Auto Review Design

## Goal

Reduce mechanical data entry in the A-share review page by pushing captured Tonghuashun Investment Ledger data directly into the local review page.

## User Flow

1. Start a local helper server.
2. Open the review page through the helper server.
3. Log in to Tonghuashun Investment Ledger in the normal browser.
4. Click a bookmarklet on the Tonghuashun page.
5. The bookmarklet captures read-only account, holding, asset, and trade responses and pushes them to the local helper.
6. The review page polls the helper and auto-fills account capital, daily P/L, position level, and trade rows.
7. The user manually fills trade reasons, plan status, trade scores, emotions, and tomorrow's plan.

## Security Boundaries

- Do not collect passwords.
- Do not store cookies or tokens.
- Do not call write endpoints.
- Only accept pushes from the browser to `127.0.0.1`.
- Save captured data under local `data/tzzb/` files ignored by Git.

## Architecture

- `tools/tzzb-local-helper.mjs`: local HTTP server for static files, capture ingestion, latest capture retrieval, and bookmarklet delivery.
- `tools/tzzb-bookmarklet-source.js`: source script injected by bookmarklet on the Tonghuashun page.
- `tools/tzzb-review-mapper.mjs`: shared pure mapping logic from captured endpoint responses to review-page fields.
- `index.html`: adds an import/auto-fill button and client-side helper polling.
- Tests cover mapping from real captured data to normalized review fields.

## Data Mapping

- Account capital: latest `stock_position.ex_data.position` market values plus `money_remain`, falling back to latest `asset_trend.ex_data.total_asset`.
- Daily P/L: latest `stock_card.ex_data.now_profit`, falling back to latest `time_share.ex_data.data`.
- Position: holding value divided by total account value, formatted into the existing `position` select options.
- Trades: `merge_day_trading.ex_data.data`, falling back to `get_money_history.ex_data.list`.
- Holding summary: `stock_position.ex_data.position`, preserved as imported notes for the generated review text.

## First Version Scope

- Auto-fill basic fields and trade table.
- Preserve manual fields for reasons, plan status, score, and emotion.
- Show import status on the review page.
- Keep raw captured data locally for audit.

## Out of Scope

- Browser extension packaging.
- Fully automatic login.
- Cookie-based scraping.
- Automatic trade scoring or reason generation.
