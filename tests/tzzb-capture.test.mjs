import assert from 'node:assert/strict';
import { shouldCaptureResponse } from '../tools/tzzb-capture-lib.mjs';

function fakeResponse({ url, method = 'GET', contentType = 'application/json' }) {
  return {
    url: () => url,
    headers: () => ({ 'content-type': contentType }),
    request: () => ({ method: () => method })
  };
}

assert.equal(
  shouldCaptureResponse(fakeResponse({
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v1/account_list'
  })),
  true,
  'captures tzzb account API responses'
);

assert.equal(
  shouldCaptureResponse(fakeResponse({
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/asset/v1/stock_position',
    method: 'POST',
    contentType: 'text/plain'
  })),
  true,
  'captures caishen_fund responses even when content type is not JSON'
);

assert.equal(
  shouldCaptureResponse(fakeResponse({
    url: 'https://example.com/caishen_fund/pc/account/v1/account_list'
  })),
  false,
  'skips non-tzzb domains'
);

assert.equal(
  shouldCaptureResponse(fakeResponse({
    url: 'https://tzzb.10jqka.com.cn/static/logo.png',
    contentType: 'image/png'
  })),
  false,
  'skips static non-JSON assets'
);

assert.equal(
  shouldCaptureResponse(fakeResponse({
    url: 'https://tzzb.10jqka.com.cn/api/caishen_fund/pc/account/v1/edit_account',
    method: 'PUT'
  })),
  false,
  'skips unsupported methods'
);

console.log('PASS tzzb capture filters');
