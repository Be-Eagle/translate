const BING_SESSION_PAGES = [
  {
    url: 'https://www.bing.com/translator?ref=TThis&from=auto-detect&to=zh-Hans',
    origin: 'https://www.bing.com',
  },
  {
    url: 'https://cn.bing.com/translator?ref=TThis&from=auto-detect&to=zh-Hans',
    origin: 'https://cn.bing.com',
  },
];
const BING_TRANSLATOR_PATH = '/ttranslatev3';
const BING_PROXY_PREFIX = '/proxy/';

export const BING_TRANSLATION_PROVIDER = 'bing';
export const BING_TRANSLATION_LABEL = 'Bing 网页翻译（免密钥）';

const LANGUAGE_ALIASES = new Map([
  ['简体中文', 'zh-Hans'], ['中文', 'zh-Hans'], ['简中', 'zh-Hans'],
  ['繁体中文', 'zh-Hant'], ['繁中', 'zh-Hant'], ['日语', 'ja'], ['日本語', 'ja'],
  ['英语', 'en'], ['英文', 'en'], ['韩语', 'ko'], ['한국어', 'ko'], ['法语', 'fr'],
  ['德语', 'de'], ['西班牙语', 'es'], ['葡萄牙语', 'pt'], ['俄语', 'ru'],
]);

function encodeProxyTarget(url) {
  const target = String(url);
  const separator = target.indexOf('?');
  if (separator < 0) return `${BING_PROXY_PREFIX}${target}`;
  const base = target.slice(0, separator);
  const query = target.slice(separator + 1);
  return `${BING_PROXY_PREFIX}${base}%3F${encodeURIComponent(query)}`;
}

function requestCandidates(url, useProxy) {
  if (!useProxy) return [String(url)];
  return [encodeProxyTarget(url), String(url)];
}

function decodeHtmlEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|quot|apos|amp|lt|gt|nbsp);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return match;
  });
}

function decodePageSource(value) {
  let source = String(value ?? '');
  for (let pass = 0; pass < 3; pass += 1) {
    const before = source;
    source = decodeHtmlEntities(source)
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\(["'])/g, '$1');
    try {
      const parsed = JSON.parse(source);
      if (typeof parsed === 'string') source = parsed;
    } catch {
      // The normal response is HTML, not JSON.
    }
    if (source === before) break;
  }
  return source;
}

function pageSummary(source) {
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  const markers = [
    ['tauriShell', /<title[^>]*>\s*TauriTavern\s*<\/title>/i],
    ['captcha', /captcha|showcaptcha/i],
    ['代理错误', /cors proxy|proxy is disabled|cannot get \/proxy|error in cors proxy/i],
    ['访问拒绝', /access denied|forbidden|unusual traffic|robot/i],
    ['Bing会话字段', /AbusePreventionHelper/i],
  ].filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  return `页面长度 ${source.length}${title ? `，标题“${title.slice(0, 80)}”` : ''}${markers.length ? `，命中：${markers.join('、')}` : ''}`;
}

function sessionError(source, page) {
  const detail = pageSummary(source);
  if (/<title[^>]*>\s*TauriTavern\s*<\/title>/i.test(source)) {
    return new Error(`请求命中了 TauriTavern 首页，而不是 Bing（${detail}）。已自动切换直连；如果随后仍失败，请确认 TauriTavern 允许外部网络请求。`);
  }
  if (/cors proxy|proxy is disabled|cannot get \/proxy|error in cors proxy/i.test(source)) {
    return new Error(`酒馆代理没有返回 Bing 页面（${detail}）。请确认 SillyTavern 已开启 enableCorsProxy。`);
  }
  if (/captcha|showcaptcha|access denied|forbidden|unusual traffic|robot/i.test(source)) {
    return new Error(`Bing 返回了验证或拒绝页面（${detail}）。请更换网络或代理后重试。`);
  }
  return new Error(`Bing 网页翻译没有返回可用的会话信息（${detail}）。`);
}

async function requestText(fetchImpl, url, init, { useProxy, signal }) {
  let lastError = null;
  for (const candidate of requestCandidates(url, useProxy)) {
    try {
      const response = await fetchImpl(candidate, {
        ...init,
        signal,
        cache: 'no-store',
        redirect: 'follow',
        headers: {
          Accept: init.method === 'POST' ? 'application/json, text/plain, */*' : 'text/html, application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(init.headers || {}),
        },
      });
      if (!response?.ok) throw new Error(`Bing 请求失败（HTTP ${response?.status ?? '未知'}）。`);
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

export function parseBingSession(html, { origin = '' } = {}) {
  const source = decodePageSource(html);
  const helper = source.match(/["']?params_AbusePreventionHelper["']?\s*[:=]\s*\[\s*(?:["']([^"']+)["']|([^,\]\s]+))\s*,\s*(?:["']([^"']+)["']|([^,\]\s]+))/i);
  if (!helper) throw sessionError(source, origin);
  const ig = source.match(/(?:["']?IG["']?\s*[:=]\s*["'])([^"']+)/i)?.[1] || '';
  const iid = source.match(/data-iid\s*=\s*["']([^"']+)["']/i)?.[1] || 'translator.5028.1';
  const session = { key: helper[1] || helper[2], token: helper[3] || helper[4], ig, iid };
  if (origin) session.origin = origin;
  return session;
}

export function buildBingRequest(text, session, { fromLanguage = 'auto-detect', targetLanguage = 'zh-Hans' } = {}) {
  const origin = session?.origin || 'https://www.bing.com';
  const query = new URLSearchParams({
    isVertical: '1',
    IID: session?.iid || 'translator.5028.1',
    SFX: String(session?.sfx ?? 1),
  });
  if (session?.ig) query.set('IG', session.ig);
  const body = new URLSearchParams({
    fromLang: normalizeBingLanguage(fromLanguage),
    to: normalizeBingLanguage(targetLanguage),
    text: String(text ?? ''),
    token: String(session?.token ?? ''),
    key: String(session?.key ?? ''),
  });
  return { url: `${origin}${BING_TRANSLATOR_PATH}?${query}`, body };
}

export function extractBingTranslation(payload) {
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error(`Bing 翻译返回了无法解析的内容（${pageSummary(data)}）。`);
    }
  }
  if (data?.ShowCaptcha === true || data?.showCaptcha === true) throw new Error('Bing 网页翻译要求验证码，请稍后再试或更换网络。');
  if (data?.StatusCode === 401 || data?.statusCode === 401) throw new Error('Bing 网页翻译暂时限制了请求，请稍后再试。');
  const text = Array.isArray(data) ? data[0]?.translations?.[0]?.text : data?.translations?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Bing 网页翻译返回了空结果。');
  return text.trim();
}

async function loadBingSession(fetchImpl, signal, useProxy) {
  let lastError = null;
  for (const page of BING_SESSION_PAGES) {
    try {
      const html = await requestText(fetchImpl, page.url, { method: 'GET' }, { useProxy, signal });
      return parseBingSession(html, page);
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
  const raw = await requestText(fetchImpl, requestData.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestData.body,
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