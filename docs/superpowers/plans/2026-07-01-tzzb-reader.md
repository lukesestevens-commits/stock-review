# TZZB Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local read-only workflow that captures authenticated Investment Ledger data after the user logs in manually.

**Architecture:** Use a browser session as the source of authentication. Capture completed JSON responses from the target site, classify read-only account and asset endpoints, and save response bodies locally for repeatable analysis. Only add a direct script after endpoint behavior is confirmed.

**Tech Stack:** Browser automation, local JavaScript utility scripts, JSON output files.

---

## File Structure

- Create: `tools/tzzb-capture.mjs`
  - Runs a controlled browser session, waits for manual login, captures JSON responses from `tzzb.10jqka.com.cn`, and writes them to disk.
- Create: `data/tzzb/.gitkeep`
  - Keeps the output folder present. Captured data files are local working files.
- Modify: none of the existing site files.

### Task 1: Capture Authenticated Responses

**Files:**
- Create: `tools/tzzb-capture.mjs`
- Create: `data/tzzb/.gitkeep`

- [ ] **Step 1: Inspect available browser tooling**

Run: `which node || true`

Expected: If Node is unavailable, use the bundled workspace runtime before writing the script.

- [ ] **Step 2: Create the output folder**

```bash
mkdir -p data/tzzb tools
touch data/tzzb/.gitkeep
```

- [ ] **Step 3: Create the capture script**

```javascript
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const targetUrl = "https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/gcQSW6A";
const outputDir = path.resolve("data/tzzb");
const captured = [];

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

page.on("response", async (response) => {
  const url = response.url();
  const contentType = response.headers()["content-type"] || "";
  const method = response.request().method();

  if (!url.includes("tzzb.10jqka.com.cn")) return;
  if (method !== "GET" && method !== "POST") return;
  if (!contentType.includes("json") && !url.includes("/caishen_fund/")) return;

  try {
    const text = await response.text();
    const record = {
      capturedAt: new Date().toISOString(),
      method,
      status: response.status(),
      url,
      requestPostData: response.request().postData(),
      responseText: text,
    };
    captured.push(record);
    console.log(`[capture] ${response.status()} ${method} ${url}`);
  } catch (error) {
    console.log(`[skip] ${method} ${url}: ${error.message}`);
  }
});

await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
console.log("Please log in manually in the opened browser.");
console.log("After the account page finishes loading, return here and press Enter.");

process.stdin.resume();
await new Promise((resolve) => process.stdin.once("data", resolve));

const outputPath = path.join(outputDir, `raw-responses-${Date.now()}.json`);
await fs.writeFile(outputPath, JSON.stringify(captured, null, 2), "utf8");
console.log(`Saved ${captured.length} responses to ${outputPath}`);

await browser.close();
```

- [ ] **Step 4: Run the capture script**

Run: `node tools/tzzb-capture.mjs`

Expected: A browser opens, the user logs in manually, and a JSON file appears under `data/tzzb/`.

- [ ] **Step 5: Review captured endpoints**

Run: `python3 - <<'PY'
import json, glob
latest = sorted(glob.glob("data/tzzb/raw-responses-*.json"))[-1]
records = json.load(open(latest))
for r in records:
    if "/caishen_fund/" in r["url"]:
        print(r["status"], r["method"], r["url"])
PY`

Expected: Read-only account, asset, position, or quote endpoints are listed.

### Task 2: Decide Extraction Path

**Files:**
- Modify: `tools/tzzb-capture.mjs` if browser-only extraction is required.
- Create: `tools/tzzb-export.mjs` only if direct endpoint replay works.

- [ ] **Step 1: Check whether response bodies contain usable JSON**

Run: `python3 - <<'PY'
import json, glob
latest = sorted(glob.glob("data/tzzb/raw-responses-*.json"))[-1]
records = json.load(open(latest))
for r in records:
    body = r["responseText"][:120].replace("\\n", " ")
    if "/caishen_fund/" in r["url"]:
        print(r["url"], body)
PY`

Expected: At least one response body starts with JSON-like text such as `{` or `[`.

- [ ] **Step 2: If direct replay is possible, create an exporter**

```javascript
import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node tools/tzzb-export.mjs data/tzzb/raw-responses-<timestamp>.json");
  process.exit(1);
}

const records = JSON.parse(await fs.readFile(input, "utf8"));
const selected = records
  .filter((record) => record.url.includes("/caishen_fund/"))
  .map((record) => {
    let parsed = null;
    try {
      parsed = JSON.parse(record.responseText);
    } catch {
      parsed = record.responseText;
    }
    return {
      capturedAt: record.capturedAt,
      method: record.method,
      status: record.status,
      url: record.url,
      data: parsed,
    };
  });

const outputPath = path.resolve("data/tzzb/extracted.json");
await fs.writeFile(outputPath, JSON.stringify(selected, null, 2), "utf8");
console.log(`Saved ${selected.length} extracted records to ${outputPath}`);
```

- [ ] **Step 3: Run exporter**

Run: `node tools/tzzb-export.mjs data/tzzb/raw-responses-<timestamp>.json`

Expected: `data/tzzb/extracted.json` contains parsed records for the relevant read-only endpoints.

## Verification

- Run the capture script once with manual login.
- Confirm the raw response file exists and contains no password fields.
- Confirm extracted output contains only read-only response data.
- Stop if the site rejects browser automation or requires controls that should not be bypassed.
