import assert from 'node:assert/strict';
import {
  MARKET_ALGORITHM_VERSION,
  classifyMarketSnapshot,
  parseSohuConceptPayload,
  selectStrongConceptBoards
} from '../tools/market-public-data.mjs';

const sohuPayload = `<script>PEAK_ODIA(['pllist',
['4570','昨日连板','10','15.82','+0.30','9.93%','7099093','85027844','cn_600992','贵绳股份','11.72','+1.07','10.05%'],
['7741','医药电商','49','14.35','+0.24','3.00%','11596032','116650884','cn_600129','太极集团','17.94','+1.36','8.20%'],
['7970','GPU','13','177.62','+1.96','2.00%','13196240','900000000','cn_688802','沐曦股份-U','972.86','+63.51','6.98%'],
['4485','人工智能','120','20.00','+0.30','1.80%','20000000','800000000','cn_000001','样本股','10.00','+0.10','1.00%']]);</script>`;

const parsed = parseSohuConceptPayload(sohuPayload);
assert.equal(parsed.length, 4);
assert.deepEqual(parsed[1], {
  code: '7741',
  name: '医药电商',
  changePercent: 3,
  turnoverVolume: 11596032,
  turnoverAmount: 116650884,
  label: '概念',
  source: 'sohu-public-concept-board'
});

const boards = [
  { code: 'noise-1', name: '昨日连板', label: '概念', changePercent: 9, turnoverAmount: 1_000_000_000 },
  { code: 'noise-2', name: '融资融券', label: '概念', changePercent: 8, turnoverAmount: 9_000_000_000 },
  { code: 'noise-3', name: '超大盘', label: '概念', changePercent: 7, turnoverAmount: 8_000_000_000 },
  { code: 'noise-4', name: '价值品牌', label: '概念', changePercent: 6, turnoverAmount: 7_000_000_000 },
  { code: 'a', name: '低成交强势', label: '概念', changePercent: 3.2, turnoverAmount: 10 },
  { code: 'b', name: '医药电商', label: '概念', changePercent: 3, turnoverAmount: 100 },
  { code: 'c', name: '中药概念', label: '概念', changePercent: 2.5, turnoverAmount: 600 },
  { code: 'd', name: '商汤科技概念', label: '概念', changePercent: 2.2, turnoverAmount: 300 },
  { code: 'e', name: 'GPU', label: '概念', changePercent: 2, turnoverAmount: 900 },
  { code: 'f', name: '人工智能', label: '概念', changePercent: 1.8, turnoverAmount: 800 },
  { code: 'g', name: '弱势高成交', label: '概念', changePercent: -5, turnoverAmount: 10_000 }
];
const indices = [
  { name: '上证指数', changePercent: -1.8 },
  { name: '深证成指', changePercent: -2.0 },
  { name: '创业板指', changePercent: -2.2 }
];
const selected = selectStrongConceptBoards(boards, indices, 5);
assert.deepEqual(
  selected.map((row) => row.name),
  ['低成交强势', '医药电商', '中药概念', 'GPU', '商汤科技概念']
);
assert.doesNotMatch(selected.map((row) => row.name).join(','), /昨日|融资融券|超大盘|价值品牌|弱势高成交/);

const market = classifyMarketSnapshot(indices, boards);
assert.equal(MARKET_ALGORITHM_VERSION, 'concept-ranking-v2');
assert.equal(market.algorithmVersion, MARKET_ALGORITHM_VERSION);
assert.equal(market.mainLines, '概念：低成交强势、医药电商、中药概念、GPU、商汤科技概念');
assert.match(market.marketOne, /强势方向：概念：低成交强势、医药电商、中药概念、GPU、商汤科技概念/);
assert.equal(market.boards.length, 5);
assert.ok(market.boards.every((row) => row.label === '概念'));

console.log('PASS market concept ranking');
