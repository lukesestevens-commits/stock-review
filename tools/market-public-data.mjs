const EASTMONEY_INDEX_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006&fields=f12,f14,f2,f3,f4';
const EASTMONEY_STOCK_INDEX_URLS = [
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=1.000001&fields=f43,f57,f58,f169,f170',
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=0.399001&fields=f43,f57,f58,f169,f170',
  'https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid=0.399006&fields=f43,f57,f58,f169,f170'
];
const EASTMONEY_BOARD_URLS = [
  {
    label: '行业',
    url: 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3,f62'
  },
  {
    label: '概念',
    url: 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&fid=f3&fs=m:90+t:3&fields=f12,f14,f3,f62'
  }
];
const SOHU_BOARD_URL = 'https://q.stock.sohu.com/cn/bk.shtml';
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
  Referer: 'https://q.stock.sohu.com/',
  Accept: 'text/html,*/*',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent': EASTMONEY_HEADERS['User-Agent']
};

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function signedPercent(value) {
  const n = numeric(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
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
    changeAmount: numeric(row.f4)
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
    changeAmount: numeric(row.f169)
  };
}

export function parseBoardPayload(payload, label = '') {
  const rows = payload && payload.data && Array.isArray(payload.data.diff)
    ? payload.data.diff
    : [];
  return rows.map((row) => ({
    code: String(row.f12 || ''),
    name: String(row.f14 || ''),
    changePercent: numeric(row.f3),
    netFlow: numeric(row.f62),
    label
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

function formatMainLines(boards, indexState) {
  const prefix = indexState === '指数弱' ? '抗跌板块' : '强势板块';
  const rows = Array.isArray(boards) ? boards.filter((row) => numeric(row.changePercent) > 0) : [];
  const rankedRows = Array.isArray(boards)
    ? boards.filter((row) => row.source === 'sohu-board-page' || numeric(row.rank) > 0)
    : [];
  if (!rows.length) {
    if (rankedRows.length) return `${prefix}：${rankedRows.slice(0, 5).map((row) => row.name).join('、')}`;
    return '行业/概念板块暂不可用';
  }

  const byLabel = new Map();
  for (const row of rows) {
    const label = row.label || '强势';
    if (!byLabel.has(label)) byLabel.set(label, []);
    if (byLabel.get(label).length < 3) byLabel.get(label).push(row);
  }

  return [...byLabel.entries()]
    .map(([label, items]) => `${label}：${items.map((row) => row.name).join('、')}`)
    .join('；');
}

export function classifyMarketSnapshot(indices, boards = []) {
  const rows = Array.isArray(indices) ? indices : [];
  const avg = rows.length
    ? rows.reduce((sum, row) => sum + numeric(row.changePercent), 0) / rows.length
    : 0;
  const upCount = rows.filter((row) => numeric(row.changePercent) > 0.15).length;
  const downCount = rows.filter((row) => numeric(row.changePercent) < -0.15).length;
  const top = [...rows].sort((a, b) => numeric(b.changePercent) - numeric(a.changePercent));
  const leaders = top.filter((row) => numeric(row.changePercent) > 0).slice(0, 3);

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
  const mainLines = formatMainLines(boards, indexState);

  return {
    indexState,
    mood,
    actionEnv,
    mainLines,
    marketOne: `${quoteText || '公开指数数据暂不可用'}；${indexState}，${mood}，适合${actionEnv}。强势方向：${mainLines}。`,
    indices: rows,
    boards,
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

async function fetchBoardRows(fetchImpl) {
  const settled = await Promise.allSettled(
    EASTMONEY_BOARD_URLS.map(async ({ label, url }) => parseBoardPayload(await requestJson(fetchImpl, url), label))
  );
  const eastmoneyRows = settled
    .filter((item) => item.status === 'fulfilled')
    .flatMap((item) => item.value);
  if (eastmoneyRows.length) return eastmoneyRows;

  try {
    return parseSohuBoardHtml(await requestDecodedText(fetchImpl, `${SOHU_BOARD_URL}?_=${Date.now()}`, SOHU_HEADERS));
  } catch {
    return [];
  }
}

export async function fetchMarketSnapshot({ fetchImpl = fetch, fixture = process.env.TZZB_MARKET_FIXTURE } = {}) {
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
