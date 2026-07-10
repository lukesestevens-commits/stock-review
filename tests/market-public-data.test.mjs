import assert from 'node:assert/strict';
import {
  classifyMarketSnapshot,
  fetchMarketSnapshot,
  parseBoardPayload,
  parseEastmoneyIndexPayload,
  parseSohuBoardHtml,
  parseStockIndexPayload,
  parseTencentIndexText
} from '../tools/market-public-data.mjs';

const parsed = parseEastmoneyIndexPayload({
  data: {
    diff: [
      { f12: '000001', f14: '上证指数', f2: 3200.1, f3: 0.42, f4: 13.2 },
      { f12: '399001', f14: '深证成指', f2: 10000.2, f3: 0.61, f4: 60.1 },
      { f12: '399006', f14: '创业板指', f2: 2200.3, f3: -0.12, f4: -2.7 }
    ]
  }
});

assert.equal(parsed.length, 3);
assert.equal(parsed[0].name, '上证指数');
assert.equal(parsed[1].changePercent, 0.61);

const stockIndex = parseStockIndexPayload({
  data: { f57: '000001', f58: '上证指数', f43: 3970.88, f169: -19.36, f170: -0.49 }
});
assert.deepEqual(stockIndex, {
  code: '000001',
  name: '上证指数',
  price: 3970.88,
  changePercent: -0.49,
  changeAmount: -19.36
});

const boards = parseBoardPayload({
  data: {
    diff: [
      { f12: 'BK1573', f14: '油田服务', f3: 4.69 },
      { f12: 'BK1448', f14: '横向通用软件', f3: 3.51 }
    ]
  }
});
assert.deepEqual(boards.map((row) => row.name), ['油田服务', '横向通用软件']);

const sohuBoards = parseSohuBoardHtml(`
  <li bk_id="1631">行业分类<em></em></li>
  <li bk_id="1630">概念板块<em></em></li>
  <td class="e1">1</td><td class="e2"><a href="bk_3098.shtml" target="_blank">传媒</a></td>
  <td class="e1">2</td><td class="e2"><a href="bk_3100.shtml" target="_blank">非银金融</a></td>
  <td class="e1">64</td><td class="e2"><a href="bk_4372.shtml" target="_blank">3D打印</a></td>
  <td class="e1">65</td><td class="e2"><a href="bk_4376.shtml" target="_blank">阿里概念</a></td>
`);
assert.deepEqual(sohuBoards.map((row) => row.name), ['传媒', '非银金融', '3D打印', '阿里概念']);
assert.equal(sohuBoards[0].label, '板块');

const tencentIndices = parseTencentIndexText(`
v_s_sh000001="1~MOJIBAKE~000001~3970.88~-19.36~-0.49~496229374~119235580~~664834.95~ZS~";
v_s_sz399001="51~MOJIBAKE~399001~14939.73~-285.38~-1.87~654790391~137116733~~459373.71~ZS~";
v_s_sz399006="51~MOJIBAKE~399006~3845.35~-66.56~-1.70~192572049~65177354~~199476.48~ZS~";
`);
assert.equal(tencentIndices.length, 3);
assert.equal(tencentIndices[0].name, '上证指数');
assert.equal(tencentIndices[0].changePercent, -0.49);

const fullTencentIndices = parseTencentIndexText(`
v_sh000001="1~MOJIBAKE~000001~4036.59~3970.88~3977.55~553063980~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260709160402~65.71~1.65~4040.54~3938.88";
v_sz399001="51~MOJIBAKE~399001~15398.73~14939.73~15038.47~716541158~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260709160433~459.00~3.07~15419.12~14781.24";
`);
assert.equal(fullTencentIndices[0].price, 4036.59);
assert.equal(fullTencentIndices[0].changeAmount, 65.71);
assert.equal(fullTencentIndices[0].changePercent, 1.65);
assert.equal(fullTencentIndices[0].quoteTime, '2026-07-09 16:04:02');

const strong = classifyMarketSnapshot(parsed);
assert.equal(strong.indexState, '指数强');
assert.equal(strong.mood, '分化');
assert.equal(strong.actionEnv, '只做核心');
assert.match(strong.marketOne, /上证指数\+0\.42%/);
assert.equal(strong.mainLines, '行业/概念板块暂不可用');

const weak = classifyMarketSnapshot([
  { name: '上证指数', changePercent: -1.2 },
  { name: '深证成指', changePercent: -1.6 },
  { name: '创业板指', changePercent: -2.1 }
]);
assert.equal(weak.indexState, '指数弱');
assert.equal(weak.mood, '退潮');
assert.equal(weak.actionEnv, '防守');

const fallbackSnapshot = await fetchMarketSnapshot({
  fetchImpl: async (url) => {
    const textUrl = String(url);
    if (textUrl.includes('/ulist.np/get')) {
      throw new Error('batch index unavailable');
    }
    if (textUrl.includes('secid=1.000001')) {
      return { ok: true, json: async () => ({ data: { f57: '000001', f58: '上证指数', f43: 3970.88, f169: -19.36, f170: -0.49 } }) };
    }
    if (textUrl.includes('secid=0.399001')) {
      return { ok: true, json: async () => ({ data: { f57: '399001', f58: '深证成指', f43: 14939.73, f169: -285.38, f170: -1.87 } }) };
    }
    if (textUrl.includes('secid=0.399006')) {
      return { ok: true, json: async () => ({ data: { f57: '399006', f58: '创业板指', f43: 3845.35, f169: -66.56, f170: -1.70 } }) };
    }
    if (textUrl.includes('fs=m:90+t:2')) {
      return { ok: true, json: async () => ({ data: { diff: [{ f12: 'BK1573', f14: '油田服务', f3: 4.69 }] } }) };
    }
    if (textUrl.includes('fs=m:90+t:3')) {
      return { ok: true, json: async () => ({ data: { diff: [{ f12: 'BK0885', f14: 'VPN', f3: 5.2 }] } }) };
    }
    throw new Error(`unexpected url ${textUrl}`);
  }
});
assert.equal(fallbackSnapshot.indexState, '指数弱');
assert.equal(fallbackSnapshot.mood, '退潮');
assert.match(fallbackSnapshot.mainLines, /油田服务/);
assert.match(fallbackSnapshot.mainLines, /VPN/);
assert.match(fallbackSnapshot.marketOne, /上证指数-0\.49%/);

const tencentFallbackSnapshot = await fetchMarketSnapshot({
  fetchImpl: async (url) => {
    const textUrl = String(url);
    if (textUrl.includes('qt.gtimg.cn')) {
      return {
        ok: true,
        text: async () => `
v_sh000001="1~MOJIBAKE~000001~4036.59~3970.88~3977.55~553063980~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260709160402~65.71~1.65~4040.54~3938.88";
v_sz399001="51~MOJIBAKE~399001~15398.73~14939.73~15038.47~716541158~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260709160433~459.00~3.07~15419.12~14781.24";
v_sz399006="51~MOJIBAKE~399006~4018.17~3845.35~3892.12~208378136~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260709160348~172.82~4.49~4025.32~3812.66";
`
      };
    }
    if (textUrl.includes('q.stock.sohu.com')) {
      return {
        ok: true,
        text: async () => `
          <td class="e1">1</td><td class="e2"><a href="bk_3098.shtml" target="_blank">传媒</a></td>
          <td class="e1">2</td><td class="e2"><a href="bk_3100.shtml" target="_blank">非银金融</a></td>
          <td class="e1">64</td><td class="e2"><a href="bk_4372.shtml" target="_blank">3D打印</a></td>
        `
      };
    }
    throw new Error('eastmoney unavailable');
  }
});
assert.equal(tencentFallbackSnapshot.indexState, '指数强');
assert.match(tencentFallbackSnapshot.marketOne, /深证成指\+3\.07%/);
assert.equal(tencentFallbackSnapshot.mainLines, '强势板块：传媒、非银金融、3D打印');
assert.doesNotMatch(tencentFallbackSnapshot.mainLines, /上证指数|深证成指|创业板指/);

console.log('PASS market public data');
