# TZZB Auto Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local helper and review-page integration so Tonghuashun captured data can auto-fill the existing A-share review page.

**Architecture:** A local Node HTTP server serves the review page, receives pushed captured responses from a bookmarklet, and exposes the latest normalized review payload. Pure mapping code converts captured endpoint payloads into the review page's existing field model so it is testable without a browser.

**Tech Stack:** Node.js built-ins, browser JavaScript, existing single-file `index.html`, local JSON/CSV data.

---

## File Structure

- Create: `tools/tzzb-review-mapper.mjs`
  - Pure functions for converting captured TZZB records into review fields.
- Create: `tests/tzzb-review-mapper.test.mjs`
  - Uses the real captured JSON fixture to verify mapping.
- Create: `tools/tzzb-local-helper.mjs`
  - Local server for static files, latest capture storage, bookmarklet script, and normalized review payload.
- Create: `tools/tzzb-bookmarklet-source.js`
  - Browser-side capture/push script for the Tonghuashun page.
- Modify: `index.html`
  - Adds auto-import controls and client-side fill logic.
- Modify: `.gitignore`
  - Already ignores local captured data.

## Tasks

### Task 1: Mapping

- [ ] Write a failing mapper test against `data/tzzb/raw-responses-1782916774379.json`.
- [ ] Implement `mapTzzbCaptureToReview`.
- [ ] Verify mapper test passes.

### Task 2: Local Helper

- [ ] Implement local server routes:
  - `GET /`
  - `GET /index.html`
  - `GET /tzzb/bookmarklet.js`
  - `POST /api/tzzb-capture`
  - `GET /api/tzzb-latest`
  - `GET /api/tzzb-bookmarklet`
- [ ] Persist latest raw capture to `data/tzzb/latest-capture.json`.
- [ ] Return normalized payload from `/api/tzzb-latest`.

### Task 3: Review Page Auto-Fill

- [ ] Add an auto-import panel to the existing review page.
- [ ] Add client functions to fetch latest normalized payload from helper.
- [ ] Fill existing fields:
  - `date`
  - `capital`
  - `pnl`
  - `position`
  - `tradeBody`
- [ ] Preserve manual fields for reason, plan status, score, and emotion.

### Task 4: Bookmarklet Push

- [ ] Create bookmarklet source that installs XHR/fetch interceptors.
- [ ] Push captured records to `http://127.0.0.1:8787/api/tzzb-capture`.
- [ ] Provide a bookmarklet URL from helper for easy copying.

### Task 5: Verification

- [ ] Run mapper test.
- [ ] Run existing page tests.
- [ ] Start helper and verify `/api/tzzb-latest` returns normalized data after posting a sample capture.
