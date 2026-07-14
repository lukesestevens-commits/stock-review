const EASTMONEY_INDEX_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006&fields=f12,f14,f2,f3,f4,f124';
const EASTMONEY_STOCK_INDEX_URLS = [
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=1.000001&fields=f43,f57,f58,f86,f169,f170',
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=0.399001&fields=f43,f57,f58,f86,f169,f170',
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=0.399006&fields=f43,f57,f58,f86,f169,f170'
];
const EASTMONEY_CONCEPT_URLS = [
  'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&fid=f3&fs=m:90+t:3&fields=f12,f14,f3,f5,f6,f8,f62',
  'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&fid=f6&fs=m:90+t:3&fields=f12,f14,f3,f5,f6,f8,f62'
];
const SOHU_CONCEPT_URL = 'https://q.stock.sohu.com/pl/pl-1630.html';
const TENCENT_INDEX_URL = 'https://qt.gtimg.cn/q=sh000001,sz399001,sz399006';
const TENCENT_INDEX_NAMES = {
  '000001': '上证指数',
  '399001': '深证成指',
  '399006': '创业板指'
};
const EASTMONEY_HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
  Accept: 'application/json,text/plain,*/*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
};
const TENCENT_HEADERS = {
  Referer: 'https://gu.qq.com/',
  Accept: '*/*',
  'User-Agent': EASTMONEY_HEADERS['User-Agent']
};
const SOHU_HEADERS = {
  Referer: 'https://q.stock.sohu.com/cn/bk.shtml',
  Accept: 'text/html,*/*',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent': EASTMONEY_HEADERS['User-Agent']
};

export const MARKET_ALGORITHM_VERSION = 'concept-ranking-v2';

const NON_THEME_CONCEPT_PATTERNS = [
  /昨日|连板|首板|涨停|打板|高振幅/,
  /融资融券|沪股通|深股通|MSCI|富时罗素|标准普尔|标普|HS300|深成500|创业板综/,
  /大盘|中盘|小盘|权重股|百元股|低价股|高价股|破净|低市盈率|高市盈率|红利股|价值股|价值品牌|科技风格/,
  /基金重仓|社保重仓|证金汇金|QFII/,
  /国债逆回购/
];

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formattedNumeric(value) {
  const n = Number(String(value ?? '').replace(/[+,%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function signedPercent(value) {
  const n = numeric(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function shanghaiQuoteTime(value) {
  const seconds = numeric(value);
  if (seconds <= 0) return '';
  const shifted = new Date(seconds * 1000 + 8 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)}`;
}

export function parseEastmoneyIndexPayload(payload) {
  const rows = payload && payload.data && Array.isArray(payload.data.diff)
    ? payload.data.diff
    : [];
  return rows.map((row) => ({
    code: String(row.f12 || ''),
    name: String(row.f14 || ''),
    price: numeric(row.f2),
    changePercent: numeric(row.f3),
    changeAmount: numeric(row.f4),
    quoteTime: shanghaiQuoteTime(row.f124)
  })).filter((row) => row.code && row.name);
}

export function parseStockIndexPayload(payload) {
  const row = payload && payload.data;
  if (!row || typeof row !== 'object') return null;
  const code = String(row.f57 || '');
  const name = String(row.f58 || '');
  if (!code || !name) return null;
  return {
    code,
    name,
    price: numeric(row.f43),
    changePercent: numeric(row.f170),
    changeAmount: numeric(row.f169),
    quoteTime: shanghaiQuoteTime(row.f86)
  };
}

export function parseBoardPayload(payload, label = '概念') {
  const rows = payload && payload.data && Array.isArray(payload.data.diff)
    ? payload.data.diff
    : [];
  return rows.map((row) => ({
    code: String(row.f12 || ''),
    name: String(row.f14 || ''),
    changePercent: numeric(row.f3),
    turnoverVolume: numeric(row.f5),
    turnoverAmount: numeric(row.f6),
    netFlow: numeric(row.f62),
    label,
    source: 'eastmoney-public-concept-board'
  })).filter((row) => row.code && row.name);
}

export function parseTencentIndexText(text) {
  const rows = [];
  const matches = String(text || '').matchAll(/v_(?:s_)?[a-z]{2}(\d{6})="([^"]*)"/g);
  for (const match of matches) {
    const fields = match[2].split('~');
    const code = fields[2] || match[1];
    const name = TENCENT_INDEX_NAMES[code] || fields[1] || code;
    const fullQuote = /^\d{14}$/.test(fields[30] || '');
    rows.push({
      code,
      name,
      price: numeric(fields[3]),
      changeAmount: fullQuote ? numeric(fields[31]) : numeric(fields[4]),
      changePercent: fullQuote ? numeric(fields[32]) : numeric(fields[5]),
      quoteTime: fullQuote
        ? `${fields[30].slice(0, 4)}-${fields[30].slice(4, 6)}-${fields[30].slice(6, 8)} ${fields[30].slice(8, 10)}:${fields[30].slice(10, 12)}:${fields[30].slice(12, 14)}`
        : '',
      source: 'tencent-public-index'
    });
  }
  return rows.filter((row) => row.code && row.name);
}

export function parseSohuBoardHtml(html) {
  const rows = [];
  const seen = new Set();
  const matches = String(html || '').matchAll(/<td class="e1">\s*(\d+)\s*<\/td>\s*<td class="e2"><a href="bk_(\d+)\.shtml"[^>]*>([^<]+)<\/a><\/td>/g);
  for (const match of matches) {
    const rank = numeric(match[1]);
    const code = `bk_${match[2]}`;
    const name = match[3].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      code,
      name,
      rank,
      changePercent: 0,
      netFlow: 0,
      label: '板块',
      source: 'sohu-board-page'
    });
    if (rows.length >= 6) break;
  }
  return rows;
}

export function parseSohuConceptPayload(text) {
  const rows = [];
  const matches = String(text || '').matchAll(/\[((?:'[^']*',){12}'[^']*')\]/g);
  for (const match of matches) {
    const fields = [...match[1].matchAll(/'([^']*)'/g)].map((field) => field[1].trim());
    if (fields.length !== 13 || !fields[0] || !fields[1]) continue;
    rows.push({
      code: fields[0],
      name: fields[1],
      changePercent: formattedNumeric(fields[5]),
      turnoverVolume: formattedNumeric(fields[6]),
      turnoverAmount: formattedNumeric(fields[7]),
      label: '概念',
      source: 'sohu-public-concept-board'
    });
  }
  return rows;
}

function isUsefulConcept(row) {
  const name = String(row?.name || '').trim();
  return Boolean(
    name
    && row?.label === '概念'
    && !NON_THEME_CONCEPT_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function percentileRanks(rows, valueOf) {
  const sorted = [...rows].sort((a, b) => (
    numeric(valueOf(b)) - numeric(valueOf(a))
    || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
  ));
  const denominator = Math.max(sorted.length - 1, 1);
  return new Map(sorted.map((row, index) => [
    row.code || row.name,
    (sorted.length - index - 1) / denominator
  ]));
}

export function selectStrongConceptBoards(boards, indices = [], limit = 5) {
  const unique = new Map();
  for (const row of Array.isArray(boards) ? boards : []) {
    if (!isUsefulConcept(row)) continue;
    unique.set(row.code || row.name, row);
  }
  const concepts = [...unique.values()];
  if (!concepts.length) return [];

  const indexRows = Array.isArray(indices) ? indices : [];
  const marketAverage = indexRows.length
    ? indexRows.reduce((sum, row) => sum + numeric(row.changePercent), 0) / indexRows.length
    : 0;
  const strengthRanks = percentileRanks(concepts, (row) => row.changePercent);
  const activityRanks = percentileRanks(concepts, (row) => row.turnoverAmount);
  const scored = concepts.map((row) => {
    const key = row.code || row.name;
    const strengthScore = strengthRanks.get(key) || 0;
    const activityScore = activityRanks.get(key) || 0;
    return {
      ...row,
      strengthScore,
      activityScore,
      rankingScore: strengthScore * 0.7 + activityScore * 0.3
    };
  });
  const relative = scored.filter((row) => numeric(row.changePercent) >= marketAverage);
  const pool = relative.length >= limit
    ? relative
    : [
        ...relative,
        ...scored
          .filter((row) => numeric(row.changePercent) < marketAverage)
          .sort((a, b) => numeric(b.changePercent) - numeric(a.changePercent))
          .slice(0, limit - relative.length)
      ];

  return pool
    .sort((a, b) => (
      b.rankingScore - a.rankingScore
      || numeric(b.changePercent) - numeric(a.changePercent)
      || numeric(b.turnoverAmount) - numeric(a.turnoverAmount)
      || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
    ))
    .slice(0, limit);
}

function formatMainLines(boards) {
  if (!boards.length) return '概念板块暂不可用';
  return `概念：${boards.map((row) => row.name).join('、')}`;
}

export function classifyMarketSnapshot(indices, boards = []) {
  const rows = Array.isArray(indices) ? indices : [];
  const avg = rows.length
    ? rows.reduce((sum, row) => sum + numeric(row.changePercent), 0) / rows.length
    : 0;
  const upCount = rows.filter((row) => numeric(row.changePercent) > 0.15).length;
  const downCount = rows.filter((row) => numeric(row.changePercent) < -0.15).length;
  const top = [...rows].sort((a, b) => numeric(b.changePercent) - numeric(a.changePercent));

  let indexState = '震荡';
  if (upCount >= 2 && avg >= 0.2) indexState = '指数强';
  if (downCount >= 2 && avg <= -0.2) indexState = '指数弱';

  let mood = '分化';
  if (upCount === rows.length && avg >= 0.6) mood = '普涨';
  if (downCount >= 2 && avg <= -0.6) mood = '退潮';

  let actionEnv = '只做核心';
  if (indexState === '指数强' && mood === '普涨') actionEnv = '进攻';
  if (indexState === '指数弱') actionEnv = avg <= -2.5 ? '空仓观察' : '防守';
  if (indexState === '震荡') actionEnv = '低吸不追高';

  const quoteText = rows
    .map((row) => `${row.name}${signedPercent(row.changePercent)}`)
    .join('，');
  const strongConcepts = selectStrongConceptBoards(boards, rows, 5);
  const mainLines = formatMainLines(strongConcepts);
  const boardSource = strongConcepts[0]?.source || 'none';
  const boardQuality = strongConcepts.length ? 'live' : 'none';

  return {
    indexState,
    mood,
    actionEnv,
    algorithmVersion: MARKET_ALGORITHM_VERSION,
    mainLines,
    marketOne: `${quoteText || '公开指数数据暂不可用'}；${indexState}，${mood}，适合${actionEnv}。强势方向：${mainLines}。`,
    indices: rows,
    boards: strongConcepts,
    boardSource,
    boardQuality,
    source: rows.some((row) => row.source === 'tencent-public-index')
      ? 'tencent-public-index'
      : 'eastmoney-public-index',
    updatedAt: new Date().toISOString()
  };
}

async function requestJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: EASTMONEY_HEADERS });
  if (!res.ok) throw new Error(`公开行情接口返回 ${res.status}`);
  return res.json();
}

async function requestText(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: TENCENT_HEADERS });
  if (!res.ok) throw new Error(`公开行情接口返回 ${res.status}`);
  return res.text();
}

async function requestDecodedText(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`公开板块接口返回 ${res.status}`);
  if (typeof res.arrayBuffer !== 'function' && typeof res.text === 'function') return res.text();
  const buffer = await res.arrayBuffer();
  return new TextDecoder('gbk').decode(buffer);
}

async function fetchTencentIndexRows(fetchImpl) {
  const text = await requestText(fetchImpl, TENCENT_INDEX_URL);
  const rows = parseTencentIndexText(text);
  if (!rows.length) throw new Error('腾讯公开指数数据为空');
  return rows;
}

async function fetchIndexRows(fetchImpl) {
  try {
    const batchPayload = await requestJson(fetchImpl, EASTMONEY_INDEX_URL);
    const batchRows = parseEastmoneyIndexPayload(batchPayload);
    if (batchRows.length) return batchRows;
  } catch {
    // Some network paths reject the batch index endpoint. Fall back to one-index requests.
  }

  const settled = await Promise.allSettled(
    EASTMONEY_STOCK_INDEX_URLS.map(async (url) => parseStockIndexPayload(await requestJson(fetchImpl, url)))
  );
  const rows = settled
    .filter((item) => item.status === 'fulfilled' && item.value)
    .map((item) => item.value);
  if (!rows.length) return fetchTencentIndexRows(fetchImpl);
  return rows;
}

async function fetchConceptRows(fetchImpl) {
  try {
    const sohuRows = parseSohuConceptPayload(
      await requestDecodedText(fetchImpl, `${SOHU_CONCEPT_URL}?_=${Date.now()}`, SOHU_HEADERS)
    );
    if (sohuRows.length) return sohuRows;
  } catch {
    // Fall through to the concept-only Eastmoney endpoints.
  }

  const settled = await Promise.allSettled(
    EASTMONEY_CONCEPT_URLS.map(async (url) => parseBoardPayload(await requestJson(fetchImpl, url), '概念'))
  );
  const unique = new Map();
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue;
    for (const row of item.value) unique.set(row.code || row.name, row);
  }
  return [...unique.values()];
}

const defaultFixture = typeof process !== 'undefined'
  ? process.env?.TZZB_MARKET_FIXTURE
  : undefined;

export async function fetchMarketSnapshot({ fetchImpl = fetch, fixture = defaultFixture } = {}) {
  if (fixture) {
    const indices = parseEastmoneyIndexPayload(JSON.parse(fixture));
    return classifyMarketSnapshot(indices);
  }
  const [indices, boards] = await Promise.all([
    fetchIndexRows(fetchImpl),
    fetchConceptRows(fetchImpl)
  ]);
  return classifyMarketSnapshot(indices, boards);
}
