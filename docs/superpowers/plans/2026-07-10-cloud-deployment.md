# 复盘网站云端部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有复盘网站部署到 OpenAI Sites，以 D1 持久保存最新同花顺快照，并让电脑自动上传、手机凭访问码自动读取。

**Architecture:** 保留现有 `index.html` 和本地 Node helper，新增一个 Cloudflare Worker 兼容的云端适配层。构建脚本把页面嵌入 `dist/server/index.js`，Worker 使用 D1 保存最新快照并复用现有映射、覆盖率和市场快照模块；Sites 提供公开 HTTPS 地址与环境变量。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node.js ESM、Cloudflare Worker Fetch API、D1、OpenAI Sites、Node `node:test` 风格断言脚本。

---

### Task 1: 建立 Sites 构建边界

**Files:**
- Create: `package.json`
- Create: `.openai/hosting.json`
- Create: `tools/build-cloud-site.mjs`
- Create: `tests/cloud-build.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: 写构建失败测试**

测试执行 `npm run build`，断言生成 `dist/server/index.js`，且 `.openai/hosting.json` 声明 `d1: "DB"`、`r2: null`。生成文件必须包含页面标题和默认 Worker 导出。

```js
const worker = await fs.readFile('dist/server/index.js', 'utf8');
const hosting = JSON.parse(await fs.readFile('.openai/hosting.json', 'utf8'));
assert.match(worker, /今日复盘工作台/);
assert.match(worker, /export default/);
assert.equal(hosting.d1, 'DB');
assert.equal(hosting.r2, null);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/cloud-build.test.mjs`

Expected: FAIL，因为 `package.json` 或构建产物不存在。

- [ ] **Step 3: 实现最小构建脚本**

`package.json` 只提供无第三方依赖的构建命令：

```json
{
  "name": "tzzb-review-cloud",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node tools/build-cloud-site.mjs",
    "test": "node tests/run-all.mjs"
  }
}
```

`.gitignore` 增加 `.DS_Store`、`dist/`、`logs/` 和 `*.tar.gz`，避免把本机构建产物与日志提交到部署源码。

`.openai/hosting.json` 初始内容：

```json
{
  "d1": "DB",
  "r2": null
}
```

构建脚本清空并创建 `dist/server`，复制 `cloud/` 和三个可复用模块，并生成入口：

```js
const indexHtml = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const entry = `import { createCloudWorker } from './cloud/worker.mjs';\n` +
  `const worker = createCloudWorker({ indexHtml: ${JSON.stringify(indexHtml)} });\n` +
  `export default worker;\n`;
await fs.writeFile(path.join(outDir, 'index.js'), entry);
```

- [ ] **Step 4: 运行构建测试并确认通过**

Run: `node tests/cloud-build.test.mjs`

Expected: `PASS cloud build`。

- [ ] **Step 5: 提交构建边界**

```bash
git add package.json .openai/hosting.json tools/build-cloud-site.mjs tests/cloud-build.test.mjs .gitignore
git commit -m "build: add Sites deployment output"
```

### Task 2: 实现 D1 最新快照存储

**Files:**
- Create: `cloud/tzzb-sync-store.mjs`
- Create: `drizzle/0000_cloud_sync.sql`
- Create: `tests/cloud-sync-store.test.mjs`

- [ ] **Step 1: 写 D1 存储失败测试**

使用内存 Fake D1 验证初始化、空读取、写入和覆盖：

```js
const store = createTzzbSyncStore(fakeDb);
assert.equal(await store.readLatest(), null);
await store.writeLatest({ targetDate: '2026-07-10', receivedAt: '2026-07-10T10:00:00.000Z', records: [] });
assert.equal((await store.readLatest()).targetDate, '2026-07-10');
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/cloud-sync-store.test.mjs`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现存储层和迁移**

迁移只包含一个 SQL 语句：

```sql
CREATE TABLE IF NOT EXISTS tzzb_latest_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
```

存储层提供 `ensureSchema()`、`readLatest()` 和 `writeLatest(payload)`，所有 SQL 使用 `prepare().bind().first()/run()`；`writeLatest` 使用 `INSERT ... ON CONFLICT(id) DO UPDATE` 固定更新 `id = 1`。

- [ ] **Step 4: 运行存储测试并确认通过**

Run: `node tests/cloud-sync-store.test.mjs`

Expected: `PASS cloud sync store`。

- [ ] **Step 5: 提交存储层**

```bash
git add cloud/tzzb-sync-store.mjs drizzle/0000_cloud_sync.sql tests/cloud-sync-store.test.mjs
git commit -m "feat: persist latest sync snapshot in D1"
```

### Task 3: 实现云同步 Worker API

**Files:**
- Create: `cloud/worker.mjs`
- Create: `tests/cloud-worker.test.mjs`
- Modify: `tools/market-public-data.mjs`

- [ ] **Step 1: 写 Worker API 失败测试**

测试覆盖首页、CORS、访问码、空快照、上传、同日合并、跨日替换、健康状态、最新映射和市场快照：

```js
const app = createCloudWorker({ indexHtml: '<h1>今日复盘工作台</h1>' });
const denied = await app.fetch(new Request('https://site.test/api/sync/latest'), env);
assert.equal(denied.status, 401);
const upload = await app.fetch(new Request('https://site.test/api/sync/tzzb', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tzzb-sync-key': accessKey },
  body: JSON.stringify(readyPayload)
}), env);
assert.equal(upload.status, 200);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/cloud-worker.test.mjs`

Expected: FAIL，Worker 模块尚不存在。

- [ ] **Step 3: 实现 Worker 路由**

`createCloudWorker({ indexHtml, fetchImpl = fetch })` 返回 `{ async fetch(request, env) {} }`，并实现：

```js
if (request.method === 'POST' && url.pathname === '/api/sync/tzzb') return uploadSync(request, env);
if (request.method === 'GET' && url.pathname === '/api/sync/latest') return latestSync(request, env);
if (request.method === 'GET' && url.pathname === '/api/sync/health') return syncHealth(request, env);
if (request.method === 'GET' && url.pathname === '/api/market-snapshot') return marketSnapshot(fetchImpl);
if (request.method === 'GET' && url.pathname === '/') return html(indexHtml);
```

访问码从 `X-TZZB-Sync-Key`、Bearer 或 `key` 查询参数读取，与 `env.TZZB_SYNC_ACCESS_KEY` 比较。上传数据按 `targetDate` 过滤；同日复用 `mergeCaptureRecords`，跨日丢弃旧记录。响应复用 `analyzeTzzbEndpointCoverage` 和 `mapTzzbCaptureToReview`。

将市场模块的默认 fixture 改为 Worker 安全读取：

```js
const defaultFixture = typeof process !== 'undefined' ? process.env?.TZZB_MARKET_FIXTURE : undefined;
export async function fetchMarketSnapshot({ fetchImpl = fetch, fixture = defaultFixture } = {}) {
  if (fixture) {
    const indices = parseEastmoneyIndexPayload(JSON.parse(fixture));
    return classifyMarketSnapshot(indices);
  }
  const [indices, boards] = await Promise.all([
    fetchIndexRows(fetchImpl),
    fetchBoardRows(fetchImpl)
  ]);
  return classifyMarketSnapshot(indices, boards);
}
```

- [ ] **Step 4: 运行 Worker 与现有市场测试**

Run: `node tests/cloud-worker.test.mjs && node tests/market-public-data.test.mjs`

Expected: 两项均 PASS。

- [ ] **Step 5: 提交 Worker API**

```bash
git add cloud/worker.mjs tests/cloud-worker.test.mjs tools/market-public-data.mjs
git commit -m "feat: add access-controlled cloud sync API"
```

### Task 4: 让线上页面默认连接同源云端

**Files:**
- Modify: `index.html`
- Modify: `tests/review-page.test.mjs`

- [ ] **Step 1: 写线上默认配置失败测试**

增加测试断言 HTTPS 非本地主机默认返回云端模式和当前 origin，本地主机仍默认本地模式：

```js
assert.equal(context.getTzzbSyncConfig().mode, 'cloud');
assert.equal(context.getTzzbSyncConfig().baseUrl, 'https://review.example.com');
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/review-page.test.mjs`

Expected: FAIL，当前无本地存储时仍返回 `local` 和空地址。

- [ ] **Step 3: 实现同源默认值和云端状态文案**

```js
function isHostedReviewSite(){
  return location.protocol === 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname);
}
function getTzzbSyncConfig(){
  const hosted = isHostedReviewSite();
  return {
    mode: localStorage.getItem(STORAGE_TZZB_SYNC_MODE) || (hosted ? 'cloud' : 'local'),
    baseUrl: localStorage.getItem(STORAGE_TZZB_CLOUD_BASE) || (hosted ? location.origin : ''),
    key: localStorage.getItem(STORAGE_TZZB_CLOUD_KEY) || ''
  };
}
```

云端请求把访问码写入 `X-TZZB-Sync-Key` 请求头，不再把访问码拼入 URL；Worker 仍兼容查询参数，保证旧客户端可读取。

健康状态和手动导入提示根据模式显示“云端同步”或“本地助手”，避免手机端出现启动本地助手的错误引导。

- [ ] **Step 4: 运行页面和响应式测试**

Run: `node tests/review-page.test.mjs && node tests/layout-responsive.test.mjs`

Expected: 两项均 PASS。

- [ ] **Step 5: 提交手机端配置**

```bash
git add index.html tests/review-page.test.mjs
git commit -m "feat: default hosted page to cloud sync"
```

### Task 5: 完成本地配置与回归验证

**Files:**
- Create locally after deployment: `云同步配置.env` (ignored, contains secret)
- Modify: `docs/cloud-sync.md`
- Create: `tests/run-all.mjs`

- [ ] **Step 1: 增加统一测试入口**

`tests/run-all.mjs` 使用 `spawnSync(process.execPath, [test])` 顺序执行所有 `tests/*.mjs`，排除自身，并在任一测试失败时返回相同退出码。

- [ ] **Step 2: 运行完整测试**

Run: `npm test`

Expected: 所有现有测试和新增云端测试 PASS。

- [ ] **Step 3: 构建并检查部署包**

Run: `npm run build`

Expected: 生成 `dist/server/index.js`、Worker 依赖模块以及嵌入后的完整页面。

Run: `/Users/ruiqiwang/.codex/plugins/cache/openai-bundled/sites/0.1.27/scripts/package-site.sh "$PWD" /tmp/tzzb-review-site.tar.gz`

Expected: 输出 `/tmp/tzzb-review-site.tar.gz`，压缩包包含 `dist/server/index.js`、托管配置和 D1 迁移。

- [ ] **Step 4: 更新使用说明并提交完整源码**

文档写明线上页面默认云端模式、访问码只需输入一次、本机配置文件由部署流程生成，以及云同步失败不会影响本地捕获。

```bash
git add .gitignore .nojekyll index.html package.json .openai cloud drizzle docs tests tools "云同步配置.example.env" "启动复盘助手.command"
git commit -m "docs: finalize cloud sync deployment workflow"
```

### Task 6: 发布、配置并进行线上端到端验证

**Files:**
- Modify after site creation: `.openai/hosting.json` (`project_id` only)
- Create locally: `云同步配置.env`

- [ ] **Step 1: 创建 Sites 项目并配置访问码**

生成至少 32 字节的随机访问码。创建新 Sites 项目，将返回的 `project_id` 写入 `.openai/hosting.json`，通过 Sites 环境变量设置 `TZZB_SYNC_ACCESS_KEY`；不把访问码提交到 Git。

- [ ] **Step 2: 保存并公开部署版本**

推送已验证源码，使用构建压缩包保存版本，并调用公开部署。轮询状态直到 `succeeded` 或明确失败。

- [ ] **Step 3: 验证线上 API**

依次验证：

```text
GET  /                         -> 200 且包含“今日复盘工作台”
GET  /api/sync/latest          -> 401
POST /api/sync/tzzb + 正确访问码 -> 200
GET  /api/sync/health + 正确访问码 -> 200
GET  /api/sync/latest + 正确访问码 -> 200 且映射出持仓和交易
```

- [ ] **Step 4: 配置电脑端自动上传**

创建被 `.gitignore` 排除的 `云同步配置.env`：

```sh
TZZB_CLOUD_SYNC_URL="$DEPLOYED_URL"
TZZB_CLOUD_SYNC_KEY="$ACCESS_KEY"
```

其中 `DEPLOYED_URL` 是 Sites 部署结果返回的 HTTPS 地址，`ACCESS_KEY` 是 Step 1 生成并写入 Sites 环境变量的同一访问码。

重启本地助手，检查 `/api/tzzb-health` 版本，并提交一次本地捕获验证 `cloudSync.ok === true`。

- [ ] **Step 5: 验证手机视口与自动读取**

打开线上页面，在 390x844 视口确认无横向溢出；选择云端同步、输入访问码并保存，确认健康状态和最新数据读取成功且表单被填写。

- [ ] **Step 6: 提交最终托管元数据**

```bash
git add .openai/hosting.json
git commit -m "chore: record Sites project"
```
