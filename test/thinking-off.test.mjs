import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndependentRequest, normalizeChannel, thinkingOffFor } from '../core.js';
import { readDiagnostics } from '../diagnostics.js';
import { __testing } from '../index.js';

const FISH = { key: 'sk-test', viaProxy: true };

function sse(parts) {
  const body = new ReadableStream({
    start(controller) {
      for (const delta of parts) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => '' };
}

function host(t, answer) {
  const before = { host: globalThis.SillyTavern, fetch: globalThis.fetch, toastr: globalThis.toastr };
  t.after(() => {
    globalThis.SillyTavern = before.host;
    globalThis.fetch = before.fetch;
    globalThis.toastr = before.toastr;
  });
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('chat-completions/generate')) return new Response('', { status: 404 });
    const payload = JSON.parse(init.body);
    sent.push(payload);
    return answer(payload, sent.length);
  };
  globalThis.toastr = { success() {}, error() {}, warning() {}, info() {} };
  const context = {
    chat: [], chatId: `thinking-${Math.random()}`, name1: '小林', name2: '樱井', characterId: 0, characters: [{ name: '樱井' }],
    extensionSettings: {}, chatMetadata: {}, eventSource: { on() {}, removeListener() {} }, eventTypes: {},
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveSettingsDebounced() {}, getCurrentChatId() { return this.chatId; },
  };
  globalThis.SillyTavern = { getContext: () => context };
  return sent;
}

function onConnection(model, key = 'k-call') {
  const channel = normalizeChannel({ id: 'c1', name: '通话', url: 'https://relay.example/v1', key, model });
  __testing.configureForTest({ settings: { channels: [channel], selectedChannelId: 'c1', apiMode: 'follow', tts: { enabled: true, callChannelId: 'c1', fish: FISH } }, initialized: true });
}

test('what turns a model\'s thinking off is picked by its name, and nothing for a name not known', () => {
  assert.deepEqual(thinkingOffFor('deepseek-chat').body, { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingOffFor('DeepSeek-V3.2').body, { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingOffFor('glm-4.6').body, { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingOffFor('zai-org/GLM-4.5').body, { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingOffFor('kimi-k2-0905').body, { thinking: { type: 'disabled' } });
  const qwen = thinkingOffFor('Qwen/Qwen3-235B-A22B');
  assert.deepEqual(qwen.body, { enable_thinking: false });
  assert.equal(qwen.noThink, true);
  assert.deepEqual(thinkingOffFor('gemini-2.5-flash').body, { reasoning_effort: 'none' });
  assert.deepEqual(thinkingOffFor('gpt-5-mini').body, { reasoning_effort: 'minimal' });
  for (const name of ['gpt-5-chat-latest', 'gemini-2.5-pro', 'claude-sonnet-4-5', 'gpt-4o', 'labeler', '']) assert.equal(thinkingOffFor(name), null, name);
});

test('a request with thinking turned off goes out as the custom source, carrying the connection\'s own key', () => {
  const channel = normalizeChannel({ id: 'c1', url: 'https://relay.example/v1/chat/completions', key: 'k-call', model: 'deepseek-chat', reasoningEffort: 'low' });
  const plain = createIndependentRequest({ ...channel, reasoningEffort: '' }, [{ role: 'user', content: '在吗' }]);
  assert.equal(plain.chat_completion_source, 'openai', 'other requests are as they were');
  assert.equal('reasoning_effort' in plain, false);
  const off = createIndependentRequest(channel, [{ role: 'user', content: '在吗' }], { thinkingOff: true });
  assert.equal(off.chat_completion_source, 'custom');
  assert.equal(off.custom_url, 'https://relay.example/v1');
  assert.deepEqual(JSON.parse(off.custom_include_headers), { Authorization: 'Bearer k-call' });
  assert.deepEqual(JSON.parse(off.custom_include_body), { thinking: { type: 'disabled' } });
  assert.equal('reverse_proxy' in off || 'proxy_password' in off || 'reasoning_effort' in off, false);
  assert.equal(off.thinkingOff.label, 'DeepSeek');
  assert.equal(JSON.stringify(off).includes('thinkingOff'), false, 'the label is not sent');
  const keyless = createIndependentRequest({ ...channel, key: '' }, [{ role: 'user', content: '在吗' }], { thinkingOff: true });
  assert.deepEqual(JSON.parse(keyless.custom_include_headers), { Authorization: '' }, 'no stored key of the host goes to this address');
  const unknown = createIndependentRequest({ ...channel, model: 'labeler', reasoningEffort: '' }, [{ role: 'user', content: '在吗' }], { thinkingOff: true });
  assert.equal(unknown.chat_completion_source, 'openai', 'a model not known is sent as before');
});

test('a connection\'s reasoning effort reaches any model name, written into the request body', () => {
  const channel = normalizeChannel({ id: 'c1', url: 'https://relay.example/v1/chat/completions', key: 'k-call', model: 'deepseek-reasoner', reasoningEffort: 'high' });
  const relayed = createIndependentRequest(channel, [{ role: 'user', content: '在吗' }]);
  assert.equal(relayed.chat_completion_source, 'custom');
  assert.equal(relayed.custom_url, 'https://relay.example/v1');
  assert.deepEqual(JSON.parse(relayed.custom_include_headers), { Authorization: 'Bearer k-call' });
  assert.deepEqual(JSON.parse(relayed.custom_include_body), { reasoning_effort: 'high' });
  assert.equal(relayed.reasoning_effort, 'high', 'still there for the host to map on the models it knows');
  assert.equal('reverse_proxy' in relayed || 'proxy_password' in relayed, false);
  assert.equal(relayed.model, 'deepseek-reasoner');
  assert.equal(relayed.max_tokens, channel.maxTokens);

  // OpenAI's own names go the same way; a relay's prefixed name too.
  for (const model of ['gpt-5', 'openai/gpt-5.1', 'gemini-2.5-pro', 'grok-3-mini']) {
    const payload = createIndependentRequest({ ...channel, model, reasoningEffort: 'minimal' }, [{ role: 'user', content: '在吗' }]);
    assert.deepEqual(JSON.parse(payload.custom_include_body), { reasoning_effort: 'minimal' }, model);
  }

  // Taken out by the connection's own 排除参数: nothing is sent, the way it was.
  const excluded = createIndependentRequest({ ...channel, excludeParams: ['reasoning_effort'] }, [{ role: 'user', content: '在吗' }]);
  assert.equal(excluded.chat_completion_source, 'openai');
  assert.equal('reasoning_effort' in excluded || 'custom_include_body' in excluded, false);

  // Thinking turned off wins over an effort, where the model's switch is known.
  const off = createIndependentRequest({ ...channel, model: 'deepseek-chat' }, [{ role: 'user', content: '在吗' }], { thinkingOff: true });
  assert.deepEqual(JSON.parse(off.custom_include_body), { thinking: { type: 'disabled' } });
  assert.equal('reasoning_effort' in off, false);
});

test('a call asks with thinking off, says so, and asks again without it where the field is refused', async t => {
  let sent = host(t, () => sse([{ content: '在的。' }]));
  onConnection('Qwen3-32B');
  assert.equal(await __testing.apiLlmStream({ messages: [{ role: 'system', content: '打电话。' }, { role: 'user', content: '在吗？' }] }), '在的。');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_completion_source, 'custom');
  assert.deepEqual(JSON.parse(sent[0].custom_include_body), { enable_thinking: false });
  assert.equal(sent[0].messages.at(-1).content, '在吗？\n/no_think', 'Qwen3 is also told in the conversation');
  assert.match(readDiagnostics().at(-1).message, /已关思考（Qwen）/);

  sent = host(t, (_payload, count) => (count === 1 ? { ok: false, status: 400, body: null, text: async () => 'unknown field: thinking' } : sse([{ content: '喂？' }])));
  onConnection('deepseek-v3.2-exp');
  assert.equal(await __testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] }), '喂？');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].chat_completion_source, 'openai', 'asked again without the field');
  assert.equal(await __testing.apiLlmStream({ messages: [{ role: 'user', content: '还在吗？' }] }), '喂？');
  assert.equal(sent[2].chat_completion_source, 'openai', 'and not sent it again this session');

  sent = host(t, () => sse([{ reasoning_content: '先想一想对方是谁' }, { content: '嗯。' }]));
  onConnection('gemini-2.5-pro');
  assert.equal(await __testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] }), '嗯。');
  const line = readDiagnostics().at(-1);
  assert.equal(line.level, 'warn');
  assert.match(line.message, /模型先想了 8 字.*这个模型镜译不知道怎么关思考/, 'thinking that was not turned off is said');
});

test('a 400 that is not about the field (a wrong key) is said as it is, and the field is still sent next time', async t => {
  const sent = host(t, () => ({ ok: false, status: 400, body: null, text: async () => '{"error":"invalid api key"}' }));
  onConnection('glm-4.6', 'wrong-key');
  await assert.rejects(__testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] }), /invalid api key/);
  assert.equal(sent.length, 2, 'asked once more without the field');
  assert.equal(readDiagnostics().some(entry => /glm-4\.6 不接受关掉思考的参数/.test(entry.message)), false, 'no word of the field being refused');
  await assert.rejects(__testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] }));
  assert.equal(sent[2].chat_completion_source, 'custom', 'the field is still sent');
});

test('thinking written into the reply itself counts as thinking; an empty block does not', async t => {
  host(t, () => sse([{ content: '<think>他在问我在不在</think>在。' }]));
  onConnection('deepseek-r1');
  await __testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] });
  assert.match(readDiagnostics().at(-1).message, /模型先想了 7 字.*没关住/);
  host(t, () => sse([{ content: '<think>\n\n</think>在。' }]));
  onConnection('Qwen3-8B');
  await __testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] });
  assert.match(readDiagnostics().at(-1).message, /已关思考（Qwen）/);
});

test('a reasoning effort the provider refuses on a stream is asked for again without it, and not sent again this session', async t => {
  const refused = '{"error":"unrecognized request argument: reasoning_effort"}';
  const sent = host(t, payload => (String(payload.custom_include_body ?? '').includes('reasoning_effort') ? { ok: false, status: 400, body: null, text: async () => refused } : sse([{ content: '在的。' }])));
  const channel = normalizeChannel({ id: 'c1', name: '通话', url: 'https://relay.example/v1', key: 'k-call', model: 'grok-3-mini', reasoningEffort: 'high' });
  __testing.configureForTest({ settings: { channels: [channel], selectedChannelId: 'c1', apiMode: 'follow', tts: { enabled: true, callChannelId: 'c1', fish: FISH } }, initialized: true });
  assert.equal(await __testing.apiLlmStream({ messages: [{ role: 'user', content: '在吗？' }] }), '在的。');
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[0].custom_include_body), { reasoning_effort: 'high' });
  assert.equal(sent[1].chat_completion_source, 'openai', 'asked again without the field');
  assert.equal('reasoning_effort' in sent[1], false);
  assert.ok(readDiagnostics().some(entry => entry.scope === 'translation.effort-refused' && /grok-3-mini 不接受「推理强度」参数/.test(entry.message)));
  assert.equal(await __testing.apiLlmStream({ messages: [{ role: 'user', content: '还在吗？' }] }), '在的。');
  assert.equal(sent.length, 3);
  assert.equal(sent[2].chat_completion_source, 'openai', 'not sent again this session');
});

test('a translation whose provider refuses the reasoning effort goes through without it; another 400 does not count', async t => {
  const before = { host: globalThis.SillyTavern, toastr: globalThis.toastr };
  t.after(() => {
    globalThis.SillyTavern = before.host;
    globalThis.toastr = before.toastr;
  });
  globalThis.toastr = { success() {}, error() {}, warning() {}, info() {} };
  const sent = [];
  let refuse = payload => String(payload.custom_include_body ?? '').includes('reasoning_effort');
  const context = {
    chat: [], chatId: 'effort-refused', name1: '玩家', name2: '樱井', characterId: 0,
    characters: [{ name: '樱井', avatar: 'a.png', description: '', personality: '', scenario: '' }],
    extensionSettings: {}, substituteParams: value => value, saveChat: async () => {}, updateMessageBlock() {},
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveSettingsDebounced() {},
    eventTypes: {}, eventSource: { emit: async () => {}, on() {}, removeListener() {} },
    ChatCompletionService: {
      async processRequest(payload) {
        sent.push(payload);
        // The host relays a provider's refusal as its status text.
        if (refuse(payload)) throw new Error('Bad Request');
        const body = JSON.parse(payload.messages.at(-1).content);
        return { content: `\`\`\`json\n${JSON.stringify({ translations: body.segments.map(segment => ({ id: segment.id, text: `译文${segment.id}` })) })}\n\`\`\`` };
      },
    },
  };
  globalThis.SillyTavern = { getContext: () => context };
  __testing.initializeSettings();
  const floor = text => ({ name: '樱井', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], extra: {} });
  const configure = model => __testing.configureForTest({
    settings: { apiMode: 'independent', channels: [normalizeChannel({ id: 'c1', name: 'x', url: 'https://relay.example/v1', key: 'k', model, reasoningEffort: 'low' })], selectedChannelId: 'c1', retries: 0 },
    initialized: true,
  });

  configure('qwen-max-strict');
  context.chat.push(floor('<story_scene>\n雨が降っている。\n</story_scene>'));
  assert.equal((await __testing.translateMessage(0, { quiet: true })).skipped, false);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[0].custom_include_body), { reasoning_effort: 'low' });
  assert.equal(sent[1].chat_completion_source, 'openai');
  assert.ok(context.chat[0].mes.includes('译文1'));
  context.chat.push(floor('<story_scene>\n風が吹いている。\n</story_scene>'));
  await __testing.translateMessage(1, { quiet: true });
  assert.equal(sent.length, 3, 'one request, without the field, for the next floor');
  assert.equal(sent[2].chat_completion_source, 'openai');

  // Every request refused (a wrong key, say): said as it is, and the field still goes next time.
  configure('glm-4.6-strict');
  refuse = () => true;
  context.chat.push(floor('<story_scene>\n星が見える。\n</story_scene>'));
  await assert.rejects(__testing.translateMessage(2, { quiet: true }), /Bad Request/);
  assert.equal(readDiagnostics().some(entry => /glm-4\.6-strict 不接受/.test(entry.message)), false);
  refuse = payload => String(payload.custom_include_body ?? '').includes('reasoning_effort');
  const count = sent.length;
  await __testing.translateMessage(2, { quiet: true });
  assert.deepEqual(JSON.parse(sent[count].custom_include_body), { reasoning_effort: 'low' }, 'the field is still sent');
});
