const BING_TRANSLATOR_PAGES = [
  'https://www.bing.com/translator?ref=TThis&from=auto-detect&to=zh-Hans',
  'https://cn.bing.com/translator?ref=TThis&from=auto-detect&to=zh-Hans',
];
const BING_TRANSLATOR_ENDPOINT = 'https://www.bing.com/ttranslatev3';
const BING_PROXY_PREFIX = '/proxy/';

export const BING_TRANSLATION_PROVIDER = 'bing';
export const BING_TRANSLATION_LABEL = 'Bing 网页翻译（免密钥）';

const LANGUAGE_ALIASES = new Map([
  ['简体中文', 'zh-Hans'], ['中文', 'zh-Hans'], ['简中', 'zh-Hans'],
  ['繁体中文', 'zh-Hant'], ['繁中', 'zh-Hant'], ['日语', 'ja'], ['日本語', 'ja'],
  ['英语', 'en'], ['英文', 'en'], ['韩语', 'ko'], ['한국어', 'ko'], ['法语', 'fr'],
  ['德语', 'de'], ['西班牙语', 'es'], ['葡萄牙语', 'pt'], ['俄语', 'ru'],
]);

function proxyUrl(url, useProxy) {
  if (!useProxy) return url;
  const separator = String(url).indexOf('?');
  if (separator < 0) return `${BING_PROXY_PREFIX}${url}`;
  const base = String(url).slice(0, separator);
  const search = String(url).slice(separator + 1);
  return `${BING_PROXY_PREFIX}${base}%3F${encodeURIComponent(search)}`;
}

async function request(fetchImpl, url, init, { useProxy, signal }) {
  const candidates = useProxy ? [proxyUrl(url, true), url] : [url];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, {
        ...init,
        signal,
        cache: 'no-store',
        headers: {
          Accept: init.method === 'POST' ? 'application/json, text/plain, */*' : 'text/html, application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(init.headers || {}),
        },
      });
      if (!response?.ok) throw new Error(`Bing 网页翻译请求失败（HTTP ${response?.status ?? '未知'}）。`);
      return await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('无法连接 Bing 网页翻译。');
}

export function normalizeBingLanguage(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'zh-Hans';
  const direct = LANGUAGE_ALIASES.get(raw) || LANGUAGE_ALIASES.get(raw.toLowerCase());
  if (direct) return direct;
  const compact = raw.toLowerCase().replace(/[\s_()（）-]+/g, '');
  if (['zhcn', 'chinesesimplified', 'simplifiedchinese'].includes(compact)) return 'zh-Hans';
  if (['zhtw', 'zhhk', 'chinesetraditional', 'traditionalchinese'].includes(compact)) return 'zh-Hant';
  if (compact === 'autodetect' || compact === 'auto') return 'auto-detect';
  return /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(raw) ? raw : 'zh-Hans';
}

export function parseBingSession(html) {
  const source = String(html ?? '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'");
  const helper = source.match(/["']?params_AbusePreventionHelper["']?\s*[:=]\s*\[\s*(?:["']([^"']+)["']|([^,\]\s]+))\s*,\s*(?:["']([^"']+)["']|([^,\]\s]+))/i);
  if (!helper) throw new Error('Bing 网页翻译没有返回可用的会话信息，请检查酒馆网络或代理是否能访问 Bing。');
  const ig = source.match(/(?:["']?IG["']?\s*[:=]\s*["'])([^"']+)/i)?.[1] || '';
  const iid = source.match(/data-iid\s*=\s*["']([^"']+)["']/i)?.[1] || 'translator.5028.1';
  return { key: helper[1] || helper[2], token: helper[3] || helper[4], ig, iid };
}

export function buildBingRequest(text, session, { fromLanguage = 'auto-detect', targetLanguage = 'zh-Hans' } = {}) {
  const query = new URLSearchParams({
    isVertical: '1', IID: session?.iid || 'translator.5028.1',
    SFX: String(session?.sfx ?? 1),
  });
  if (session?.ig) query.set('IG', session.ig);
  const body = new URLSearchParams({
    fromLang: normalizeBingLanguage(fromLanguage), to: normalizeBingLanguage(targetLanguage),
    text: String(text ?? ''), token: String(session?.token ?? ''), key: String(session?.key ?? ''),
  });
  return { url: `${BING_TRANSLATOR_ENDPOINT}?${query}`, body };
}

export function extractBingTranslation(payload) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (data?.ShowCaptcha === true) throw new Error('Bing 网页翻译要求验证码，请稍后再试或更换网络。');
  if (data?.StatusCode === 401 || data?.statusCode === 401) throw new Error('Bing 网页翻译暂时限制了请求，请稍后再试。');
  const text = Array.isArray(data) ? data[0]?.translations?.[0]?.text : data?.translations?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Bing 网页翻译返回了空结果。');
  return text.trim();
}

async function loadBingSession(fetchImpl, signal, useProxy) {
  let lastError = null;
  for (const page of BING_TRANSLATOR_PAGES) {
    try {
      return parseBingSession(await request(fetchImpl, page, { method: 'GET' }, { useProxy, signal }));
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('无法读取 Bing 网页翻译会话。');
}

export async function translateBingText(text, { sourceLanguage = 'auto-detect', targetLanguage = 'zh-Hans', signal, fetchImpl = globalThis.fetch, useProxy = true, session = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的网络请求接口。');
  const value = String(text ?? '').trim();
  if (!value) return '';
  const activeSession = session || await loadBingSession(fetchImpl, signal, useProxy);
  const requestData = buildBingRequest(value, activeSession, { fromLanguage: sourceLanguage, targetLanguage });
  const raw = await request(fetchImpl, requestData.url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: requestData.body,
  }, { useProxy, signal });
  return extractBingTranslation(raw);
}

export async function translateBingSegments(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const result = new Map();
  if (!list.length) return result;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const useProxy = options.useProxy !== false;
  const session = options.session || await loadBingSession(fetchImpl, options.signal, useProxy);
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 3));
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const segment = list[cursor++];
      result.set(segment.id, await translateBingText(segment.text, { ...options, fetchImpl, useProxy, session }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return result;
}