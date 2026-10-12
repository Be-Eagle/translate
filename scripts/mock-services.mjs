// Local stand-ins for the services 测试翻译 and the scripts around it talk to, so a real SillyTavern can be
// driven end to end without any key or bill:
//   - an OpenAI-compatible chat endpoint (/v1/chat/completions, streamed or not, /v1/models): the main
//     chat's replies, 测试翻译's translation requests, and the requests of the 通用通讯终端 phone script;
//   - Fish Audio (/v1/tts, /v1/tts/stream/with-timestamp);
//   - GPT-SoVITS api_v2 (/tts);
//   - an OpenAI-style transcription endpoint (/v1/audio/transcriptions).
// The audio is a plain tone. Failures, delays and a refused request field are switched on through
// POST /__mock/config (see DEFAULTS); every request is kept in GET /__mock/log (keys reduced to
// "(present)", `?since=<seq>` for the new ones); POST /__mock/reset puts both back.
//
//   node scripts/mock-services.mjs [port]      default 8812, the port scripts/sandbox-tavern.mjs points at
import http from 'node:http';

const PORT = Number(process.argv[2]) || 8812;
const DEFAULTS = {
  llmFirstDelay: 300, llmChunkDelay: 25, llmFail: 0, llmFailStatus: 500, llmBadJson: 0, llmHang: 0,
  // A request field the chat endpoint refuses with a 400, as a provider that does not know it would
  // (`reasoning_effort`, say); '' refuses nothing.
  refuseField: '',
  mainChunkDelay: 60, translateDelay: 1500, phoneDelay: 300,
  ttsDelay: 150, ttsFail: 0, ttsFailStatus: 500, ttsHang: 0, ttsJson: 0,
  sttDelay: 200, sttFail: 0, sttText: '我刚下班，你在干什么呢？', summaryText: '',
  callReplies: [
    { subtitle: '喂？是你啊，我正想给你打电话呢。', speech: 'もしもし？あなたね、ちょうど電話しようと思ってたの。' },
    { subtitle: '这样啊，辛苦了。今天也很累吧？', speech: 'そうなんだ、お疲れさま。今日も疲れたでしょう？' },
    { subtitle: '我在看书呢。要不要周末一起出去走走？', speech: '本を読んでたの。週末、一緒に出かけない？' },
    { subtitle: '那就说好了，到时候见。', speech: 'じゃあ約束ね。またその時に。' },
  ],
};
let config = JSON.parse(JSON.stringify(DEFAULTS));
let log = [];
let seq = 0;
let callTurn = 0;
let mainTurn = 0;
let sampleTurn = 0;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const take = name => { if (config[name] > 0) { config[name] -= 1; return true; } return false; };

function record(req, body) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = /authorization|api-key|x-api-key|access-key|cookie|csrf/i.test(name) ? '(present)' : value;
  }
  const type = req.headers['content-type'] || '';
  const excerpt = type.includes('multipart') ? `(multipart ${body.length} bytes)` : body.toString('utf8').slice(0, 1500);
  const full = type.includes('multipart') ? '' : body.toString('utf8');
  const entry = { seq: ++seq, at: new Date().toISOString().slice(11, 23), method: req.method, path: req.url, headers, body: excerpt, size: body.length, full: full.slice(0, 100000) };
  log.push(entry);
  if (log.length > 300) log.shift();
  return entry;
}

function json(res, status, value) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function tone(seconds, rate, freq) {
  const count = Math.max(1, Math.round(seconds * rate));
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const envelope = Math.min(1, t * 20, (seconds - t) * 20) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 6000 * Math.max(0, envelope)), i * 2);
  }
  return pcm;
}

function wavHeader(rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(0xffffffff, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(0xffffffff, 40);
  return header;
}

async function streamAudio(res, pcm, rate, prefix) {
  res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' });
  if (prefix) res.write(prefix);
  const step = Math.round(rate * 0.1) * 2;
  for (let at = 0; at < pcm.length; at += step) {
    if (res.destroyed) return;
    res.write(pcm.subarray(at, at + step));
    await sleep(20);
  }
  res.end();
}

// The main chat's reply: a short Japanese scene in the body tag 测试翻译 translates by default.
const STORY = [
  '<story_scene>',
  '美咲は窓の外を見ていた。夕暮れの光が部屋をオレンジ色に染めている。',
  '',
  '「ねえ、今日の夜、少し話せる？」と彼女は小さな声で言った。',
  '',
  '時計の針は午後七時を指していた。商店街の明かりがひとつずつ灯り始める。',
  '',
  '「老周さんの本屋、まだ開いてるかな。一緒に行こうよ」',
  '</story_scene>',
].join('\n');

// The translations a translator would give, matched by a phrase of each line; anything else gets a
// plain Chinese line (测试翻译 sends back a line still in kana as untranslated).
const TRANSLATIONS = [
  ['窓の外', '美咲望着窗外。夕阳的余晖把房间染成了橘色。'],
  ['少し話せる', '「呐，今晚能稍微聊聊吗？」她小声说道。'],
  ['時計の針', '时针指向晚上七点。商店街的灯一盏接一盏地亮了起来。'],
  ['本屋', '「老周的书店还开着吗？一起去吧。」'],
  ['こんばんは', '美咲笑了。「晚上好。今天过得怎么样？」'],
  ['回目の約束', '这是今晚的又一次约定。'],
];
function chineseFor(source) {
  const found = TRANSLATIONS.find(([phrase]) => source.includes(phrase));
  if (found) return found[1];
  return source.includes('「') ? '「这是一句译好的对白。」' : '这是一段译好的叙述。';
}

// 测试翻译's translation request: the last user message that parses as its task JSON.
function translationTask(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const input = JSON.parse(message.content);
      if (input && Array.isArray(input.segments)) return input;
    } catch { /* not JSON */ }
  }
  return null;
}

function chatReply(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const all = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser ? String(lastUser.content) : '';
  const task = translationTask(messages);
  if (task) {
    const scene = { tone: '日常', place: '美咲的房间', time: '傍晚七点', cast: '美咲、老周', summary: '美咲约主角晚上一起去老周的书店。' };
    return { kind: 'translation', text: JSON.stringify({ translations: task.segments.map(segment => ({ id: segment.id, text: chineseFor(String(segment.text ?? '')) })), scene }) };
  }
  if (/next reply in a fictional chat/i.test(all) && all.includes('2051样例')) {
    // A floor in the 东京都2051 card's own format (its body tag is cxx-story), its two alternatives in
    // turn: send 「2051样例」 to get it, for trying the reading interface.
    sampleTurn += 1;
    const sample = '<cxx-story>\n雨水沿着校门滴下。🌧️\n<cxx-say speaker="千早爱音" expression="smile">明天见。</cxx-say>\n<cxx-say speaker="千早爱音" expression="normal" kind="thought">希望能顺利。</cxx-say>\n</cxx-story>\n<ztl>{"date":"2051年10月10日","time":"15:10","location":"羽丘校门","characters":[]}</ztl>\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    return { kind: 'main', text: sampleTurn % 2 === 1 ? sample : sample.replace('明天见。', '今天就走吧。') };
  }
  if (/next reply in a fictional chat/i.test(all)) {
    mainTurn += 1;
    return { kind: 'main', text: STORY.replace('</story_scene>', `\n今夜は${mainTurn}回目の約束だった。\n</story_scene>`) };
  }
  // The 通用通讯终端 phone script's own requests: a call turn, a translation of a text, a summary.
  if (all.includes('电话通话')) {
    if (take('llmBadJson')) return '{"subtitle":"字幕写到一半';
    const reply = config.callReplies[callTurn % config.callReplies.length];
    callTurn += 1;
    return JSON.stringify(reply);
  }
  if (all.includes('翻译助手')) return '（译）' + userText.slice(0, 200);
  if (all.includes('通讯记录整理助手')) return config.summaryText || '两人约好周末见面，气氛轻松。';
  return { kind: 'phone', text: '嗯，我在呢。刚才在忙，现在可以聊了。' };
}

async function chat(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { error: { message: 'bad json' } }); }
  if (take('llmHang')) return; // never answers
  if (take('llmFail')) return json(res, config.llmFailStatus, { error: { message: 'mock failure' } });
  if (config.refuseField && Object.hasOwn(payload, config.refuseField)) {
    return json(res, 400, { error: { message: `unrecognized request argument: ${config.refuseField}` } });
  }
  const reply = chatReply(payload);
  const kind = typeof reply === 'string' ? 'phone' : reply.kind;
  const text = typeof reply === 'string' ? reply : reply.text;
  log[log.length - 1].kind = kind;
  await sleep(kind === 'translation' ? config.translateDelay : kind === 'phone' ? config.phoneDelay : config.llmFirstDelay);
  const chunkDelay = kind === 'main' ? config.mainChunkDelay : config.llmChunkDelay;
  if (!payload.stream) {
    return json(res, 200, { id: 'mock', object: 'chat.completion', model: payload.model || 'mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 3) {
    if (res.destroyed) return;
    const piece = chars.slice(i, i + 3).join('');
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] }) + '\n\n');
    await sleep(chunkDelay);
  }
  res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

async function fish(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { message: 'bad json' }); }
  if (take('ttsHang')) return;
  await sleep(config.ttsDelay);
  if (take('ttsFail')) return json(res, config.ttsFailStatus, { status: config.ttsFailStatus, message: 'mock tts failure' });
  if (take('ttsJson')) return json(res, 200, { message: 'not audio' });
  const rate = Number(payload.sample_rate) || 44100;
  const seconds = Math.min(6, Math.max(0.4, [...String(payload.text || '')].length * 0.09));
  // Raw PCM when asked for it (边收边放); otherwise a WAV the browser can decode in place of mp3.
  return streamAudio(res, tone(seconds, rate, 440), rate, payload.format === 'pcm' ? null : wavHeader(rate));
}

// Fish's /v1/tts/stream/with-timestamp: server-sent events, each a base64 piece of the audio with the
// characters it covers. 测试翻译 joins the pieces, so only the first carries a WAV header.
async function fishTimestamps(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { message: 'bad json' }); }
  if (take('ttsHang')) return;
  await sleep(config.ttsDelay);
  if (take('ttsFail')) return json(res, config.ttsFailStatus, { status: config.ttsFailStatus, message: 'mock tts failure' });
  const text = String(payload.text || '');
  const chars = [...text.replace(/\[[^\]]*\]/g, '')].filter(ch => /[\p{L}\p{N}]/u.test(ch));
  const rate = Number(payload.sample_rate) || 44100;
  const seconds = Math.min(6, Math.max(0.4, chars.length * 0.09));
  const pcm = tone(seconds, rate, 440);
  const raw = payload.format === 'pcm';
  const pieces = 3;
  const step = Math.ceil(pcm.length / pieces / 2) * 2;
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  for (let index = 0; index < pieces; index += 1) {
    if (res.destroyed) return;
    let audio = pcm.subarray(index * step, Math.min(pcm.length, (index + 1) * step));
    if (index === 0 && !raw) audio = Buffer.concat([wavHeader(rate), audio]);
    const from = Math.floor(chars.length * index / pieces), to = Math.floor(chars.length * (index + 1) / pieces);
    const offset = seconds * index / pieces, span = seconds / pieces;
    const segments = chars.slice(from, to).map((ch, k, all) => ({ text: ch, start: span * k / Math.max(1, all.length), end: span * (k + 1) / Math.max(1, all.length) }));
    res.write('data: ' + JSON.stringify({ audio_base64: audio.toString('base64'), chunk_seq: index, chunk_audio_offset_sec: offset, alignment: { segments, audio_duration: span }, content: chars.slice(from, to).join('') }) + '\n\n');
    await sleep(60);
  }
  res.end('data: [DONE]\n\n');
}

async function gsv(req, res, body) {
  let payload = {};
  try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { message: 'bad json' }); }
  if (take('ttsHang')) return;
  await sleep(config.ttsDelay);
  if (take('ttsFail')) return json(res, config.ttsFailStatus, { message: 'mock gsv failure' });
  const rate = 32000;
  const seconds = Math.min(6, Math.max(0.4, [...String(payload.text || '')].length * 0.09));
  return streamAudio(res, tone(seconds, rate, 523), rate, wavHeader(rate));
}

async function stt(req, res) {
  await sleep(config.sttDelay);
  if (take('sttFail')) return json(res, 500, { error: { message: 'mock stt failure' } });
  return json(res, 200, { text: config.sttText });
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  await new Promise(resolve => req.on('end', resolve));
  const body = Buffer.concat(chunks);
  const path = req.url.split('?')[0].replace(/\/+$/, '');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (path === '/__mock/log') {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
    return json(res, 200, { seq, config, entries: log.filter(entry => entry.seq > since) });
  }
  if (path === '/__mock/config' && req.method === 'POST') {
    try { Object.assign(config, JSON.parse(body.toString('utf8') || '{}')); } catch { return json(res, 400, { error: 'bad json' }); }
    return json(res, 200, config);
  }
  if (path === '/__mock/reset' && req.method === 'POST') {
    config = JSON.parse(JSON.stringify(DEFAULTS)); log = []; callTurn = 0;
    return json(res, 200, { ok: true });
  }
  record(req, body);
  try {
    if (req.method === 'GET' && /\/models$/.test(path)) return json(res, 200, { object: 'list', data: [{ id: 'mock-chat', object: 'model' }, { id: 'deepseek-chat-mock', object: 'model' }] });
    if (req.method === 'POST' && /\/chat\/completions$/.test(path)) return await chat(req, res, body);
    if (req.method === 'POST' && /\/v1\/tts\/stream\/with-timestamp$/.test(path)) return await fishTimestamps(req, res, body);
    if (req.method === 'POST' && /\/v1\/tts$/.test(path)) return await fish(req, res, body);
    if (req.method === 'POST' && /\/tts$/.test(path)) return await gsv(req, res, body);
    if (req.method === 'POST' && /\/audio\/transcriptions$/.test(path)) return await stt(req, res);
    return json(res, 404, { error: 'no such mock route: ' + path });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error && error.message || error) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('mock services on http://127.0.0.1:' + PORT));
