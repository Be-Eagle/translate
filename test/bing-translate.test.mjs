import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBingRequest,
  extractBingTranslation,
  normalizeBingLanguage,
  parseBingSession,
  translateBingSegments,
} from '../bing-translate.js';

const sessionHtml = 'var params_AbusePreventionHelper = [123456, "token-456"]; var IG = "ig-789"; <div id="rich_tta" data-iid="translator.9000.1">';

test('normalizes common target language names', () => {
  assert.equal(normalizeBingLanguage('简体中文'), 'zh-Hans');
  assert.equal(normalizeBingLanguage('日语'), 'ja');
  assert.equal(normalizeBingLanguage('auto'), 'auto-detect');
});

test('parses Bing web translator session data', () => {
  assert.deepEqual(parseBingSession(sessionHtml), { key: '123456', token: 'token-456', ig: 'ig-789', iid: 'translator.9000.1' });
});

test('builds a no-key web translator request', () => {
  const request = buildBingRequest('こんにちは', parseBingSession(sessionHtml), { targetLanguage: '简体中文' });
  assert.match(request.url, /ttranslatev3\?/);
  assert.equal(request.body.get('fromLang'), 'auto-detect');
  assert.equal(request.body.get('to'), 'zh-Hans');
  assert.equal(request.body.get('text'), 'こんにちは');
  assert.equal(request.body.get('key'), '123456');
  assert.match(request.url, /IID=translator\.9000\.1/);
});

test('translates segments with one session fetch and bounded requests', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'GET') return { ok: true, text: async () => sessionHtml };
    const text = new URLSearchParams(init.body).get('text');
    return { ok: true, text: async () => JSON.stringify([{ translations: [{ text: `译文:${text}` }] }]) };
  };
  const result = await translateBingSegments([{ id: 1, text: 'one' }, { id: 2, text: 'two' }], { fetchImpl, useProxy: false });
  assert.deepEqual([...result], [[1, '译文:one'], [2, '译文:two']]);
  assert.equal(calls.filter(call => call.init.method === 'GET').length, 1);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 2);
});

test('extracts the translated text from the web response', () => {
  assert.equal(extractBingTranslation(JSON.stringify({ translations: [{ text: ' hello ' }] })), 'hello');
});