import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../github-pages/index.html', import.meta.url), 'utf8');
const destination = 'https://rqw-tzzb-review.lukesestevens.chatgpt.site/';

assert.match(html, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(html, /location\.replace\(/, 'old address should redirect without leaving a second functional site');
assert.doesNotMatch(html, /location\.(search|hash)|[?&](key|token|code)=/i, 'query strings and fragments must not be forwarded');
assert.match(html, /referrer[^>]*no-referrer/i, 'redirect should not leak the old URL as a referrer');

console.log('PASS GitHub Pages redirect');
