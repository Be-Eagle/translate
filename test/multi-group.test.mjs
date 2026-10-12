import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  assembleBilingual,
  extractFloorRegions,
  extractGeneratedTranslations,
  extractTaggedRegions,
  inspectTagConfiguration,
  normalizeChannel,
  segmentSource,
} from '../core.js';
import { __testing } from '../index.js';
import { clearDiagnostics, readDiagnostics } from '../diagnostics.js';

// A preset that writes its body in two groups, and an anti-truncation log after it that carries a copy
// of the body tag of its own.
const FLOOR = [
  '<content>',
  '雨が降っている。',
  '',
  '「来たんだね」',
  '</content>',
  '<content>',
  '彼女は笑った。',
  '</content>',
  '<secure_log>',
  '<content>',
  '防截断の控え。',
  '</content>',
  '</secure_log>',
].join('\n');
const LOG = FLOOR.slice(FLOOR.indexOf('<secure_log>'));

test('every group of a body tag is translated, and none standing inside an excluded block', () => {
  const found = extractTaggedRegions(FLOOR, ['content'], { excludedTags: ['secure_log'] });
  assert.deepEqual(found.regions.map(region => region.inner.trim()), ['雨が降っている。\n\n「来たんだね」', '彼女は笑った。']);
  assert.deepEqual(found.enclosed, [{ tagName: 'content', excludedTagName: 'secure_log' }]);
  // Without the excluded tag set, the log's copy is a body group like the others.
  assert.equal(extractTaggedRegions(FLOOR, ['content']).regions.length, 3);

  // A closed comment hides what it holds; one left open hides nothing.
  const commented = extractTaggedRegions('<!-- <content>例。</content> -->\n<content>本文。</content>', ['content']);
  assert.deepEqual(commented.regions.map(region => region.inner), ['本文。']);
  assert.deepEqual(commented.enclosed, [{ tagName: 'content', excludedTagName: '!--' }]);
  assert.deepEqual(extractTaggedRegions('<!-- 说明\n<content>本文。</content>', ['content']).regions.map(region => region.inner), ['本文。']);

  // An excluded tag written without its closing tag hides nothing either.
  assert.deepEqual(extractTaggedRegions('<secure_log>\n<content>本文。</content>', ['content'], { excludedTags: ['secure_log'] }).regions.map(region => region.inner), ['本文。']);

  // A body tag also listed as excluded does not hide its own groups.
  assert.equal(extractTaggedRegions('<content>本文。</content>', ['content'], { excludedTags: ['content'] }).regions.length, 1);

  // Every complete group inside the log: the opener left unclosed outside it is the body, to the end.
  const writing = extractTaggedRegions('<secure_log><content>控え。</content></secure_log>\n<content>まだ書いて', ['content'], { excludedTags: ['secure_log'] });
  assert.deepEqual(writing.regions.map(region => [region.inner, region.assumedClose]), [['まだ書いて', true]]);

  // Replace tags follow the same rule.
  const replaced = extractFloorRegions('<content>本文。</content>\n<secure_log><status>HP</status></secure_log>\n<status>MP</status>', {
    bodyTags: ['content'], replaceTags: ['status'], excludedTags: ['secure_log'],
  });
  assert.deepEqual(replaced.regions.map(region => [region.tagName, region.inner]), [['content', '本文。'], ['status', 'MP']]);

  // A group written inside another of the same tag goes with the outer one.
  const nested = extractTaggedRegions('<content>外。\n<content>内。</content>\n外二。</content>', ['content']);
  assert.equal(nested.regions.length, 1);
  assert.match(nested.regions[0].inner, /<content>内。<\/content>/);
  assert.deepEqual(nested.nested, [{ tagName: 'content', outerTagName: 'content' }]);
});

test('a floor whose body groups all stand inside excluded blocks says so, or is read by its 正文起点', () => {
  const inside = '<secure_log>\n<content>控え。</content>\n</secure_log>';
  assert.throws(() => extractTaggedRegions(inside, ['content'], { excludedTags: ['secure_log'] }), error => {
    assert.equal(error.code, 'BGT_NO_BODY');
    assert.match(error.message, /没有找到排除标签以外的正文标签：<content> 都写在 <secure_log> 里面/);
    return true;
  });
  const marked = extractTaggedRegions(`${inside}\n本文。`, ['content'], { excludedTags: ['secure_log'], startMarkers: ['</secure_log>'] });
  assert.equal(marked.regions[0].fromMarker, true);
  assert.equal(marked.regions[0].inner.trim(), '本文。');
});

test('the tag inspector counts the groups an excluded block keeps out', () => {
  const report = inspectTagConfiguration(FLOOR, ['content'], ['secure_log']);
  assert.deepEqual(report.bodyTags, [{ tag: 'content', count: 3, enclosed: 1, enclosedIn: ['secure_log'] }]);
  assert.equal(report.translationUnits, 3);
  assert.deepEqual(report.errors, []);
  const inside = inspectTagConfiguration('<secure_log><content>控え。</content></secure_log>', ['content'], ['secure_log']);
  assert.match(inside.errors.join(' | '), /排除标签以外/);

  const line = __testing.tagGroupsLine;
  assert.equal(line({ count: 1 }), '1 组');
  assert.equal(line({ count: 2 }), '2 组，都翻译');
  assert.equal(line({ count: 3, enclosed: 1, enclosedIn: ['secure_log'] }), '3 组，翻译其中 2 组，另 1 组在 <secure_log> 里面，不翻译');
  assert.equal(line({ count: 2, enclosed: 2, enclosedIn: ['secure_log', '!--'] }), '2 组，都在 <secure_log>、注释 里面，不翻译');
  assert.equal(line({ count: 1 }, [{ tag: 'parallel_line', outer: 'story_scene' }]), '1 组，在 <story_scene> 里面，随外层一起翻译');
  assert.equal(line({ count: 2 }, [{ tag: 'parallel_line', outer: 'story_scene' }]), '2 组，都翻译，其中 1 组在 <story_scene> 里面，随外层一起翻译');
});

test('a picture put between a line and its translation leaves the translation readable', () => {
  const options = { ...DEFAULT_SETTINGS, excludedTags: ['bbi_image'] };
  const segmented = segmentSource('雨が降っている。\n\n「来たんだね」', options);
  const bilingual = assembleBilingual(segmented.layout, new Map([[1, '下着雨。'], [2, '「你来了啊」']]), options);
  const at = bilingual.lastIndexOf('\n', bilingual.indexOf('下着雨。'));
  const pictured = `${bilingual.slice(0, at)}\n<bbi_image src="a.png"></bbi_image>${bilingual.slice(at)}`;
  assert.deepEqual([...extractGeneratedTranslations(pictured, options)], [[1, '下着雨。'], [2, '「你来了啊」']]);
  // Not an excluded block: the line has lost its translation.
  assert.deepEqual([...extractGeneratedTranslations(pictured, { ...options, excludedTags: [] })], [[2, '「你来了啊」']]);
});

// The host pieces a translation touches, with a chat of its own.
function mockHost(chatId, requests) {
  globalThis.toastr = Object.fromEntries(['success', 'error', 'warning', 'info'].map(kind => [kind, () => {}]));
  const context = {
    chat: [],
    chatId,
    name1: '玩家',
    name2: '樱井',
    extensionSettings: {},
    characters: [{ name: '樱井', avatar: 'sakurai.png', description: '', personality: '', scenario: '' }],
    characterId: 0,
    substituteParams: value => value,
    saveChat: async () => {},
    updateMessageBlock: () => {},
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveSettingsDebounced: () => {},
    eventTypes: {},
    eventSource: { emit: async () => {}, on: () => {}, removeListener: () => {} },
    ChatCompletionService: {
      async processRequest(payload) {
        const body = JSON.parse(payload.messages.at(-1).content);
        requests.push(body.segments.map(segment => segment.id));
        return { content: `\`\`\`json\n${JSON.stringify({ translations: body.segments.map(segment => ({ id: segment.id, text: `译文${requests.length}-${segment.id}` })) })}\n\`\`\`` };
      },
    },
  };
  globalThis.SillyTavern = { getContext: () => context };
  __testing.initializeSettings();
  return context;
}

const CHANNEL = normalizeChannel({ id: 'c1', name: 'test', url: 'https://relay.example/v1', key: 'k', model: 'translator' });

function restoreGlobals(t) {
  const host = globalThis.SillyTavern;
  const toastrBefore = globalThis.toastr;
  t.after(() => {
    globalThis.SillyTavern = host;
    globalThis.toastr = toastrBefore;
  });
}

function setFloor(message, mes) {
  message.mes = mes;
  message.swipes[message.swipe_id] = mes;
}

// What automatic translation did about one edit, once it has settled.
async function afterEdit(messageId) {
  const before = readDiagnostics().length;
  __testing.scheduleAuto(messageId, 'edit');
  for (let tries = 0; tries < 200; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const settled = readDiagnostics().slice(before).find(entry => entry.scope === 'translation.auto' && !/自动翻译开始/.test(entry.message));
    if (settled) return settled.message;
    const written = readDiagnostics().slice(before).find(entry => entry.scope === 'translation.done' || /翻译完成/.test(entry.message));
    if (written) return written.message;
  }
  return null;
}

test('a floor in several groups is translated in one request, the log copy left as it was', async t => {
  restoreGlobals(t);
  const requests = [];
  const context = mockHost('multi-group', requests);
  const settings = __testing.configureForTest({
    settings: { apiMode: 'independent', channels: [CHANNEL], selectedChannelId: 'c1', bodyTags: ['content'], excludedTags: ['secure_log'] },
    initialized: true,
  });
  context.chat.push({ name: '樱井', is_user: false, is_system: false, mes: FLOOR, swipe_id: 0, swipes: [FLOOR], extra: {} });

  const result = await __testing.translateMessage(0, { quiet: true });
  assert.equal(result.skipped, false);
  assert.deepEqual(requests, [[1, 2, 3]]);
  const floor = context.chat[0].mes;
  assert.ok(floor.includes('译文1-3'), 'the second group has its translation');
  assert.ok(floor.endsWith(LOG), 'the log is left exactly as it was');

  const snapshot = await __testing.readMessageSnapshot(0, settings);
  assert.equal(snapshot.translated, true);
  assert.deepEqual([...snapshot.existingTranslations], [[1, '译文1-1'], [2, '译文1-2'], [3, '译文1-3']]);
  const again = await __testing.translateMessage(0, { quiet: true });
  assert.equal(again.skipped, true);
  assert.equal(requests.length, 1);
});

test('an edit that leaves the original alone asks the model for nothing; one that changes it is translated', async t => {
  restoreGlobals(t);
  const requests = [];
  const context = mockHost('multi-group-edit', requests);
  const settings = __testing.configureForTest({
    settings: { apiMode: 'independent', channels: [CHANNEL], selectedChannelId: 'c1', bodyTags: ['content'], excludedTags: ['secure_log', 'bbi_image'], autoEdit: true },
    initialized: true,
  });
  context.chat.push({ name: '樱井', is_user: false, is_system: false, mes: FLOOR, swipe_id: 0, swipes: [FLOOR], extra: {} });
  await __testing.translateMessage(0, { quiet: true });
  assert.equal(requests.length, 1);
  clearDiagnostics();

  // An image plugin puts its picture right under the first line, above that line's translation.
  const message = context.chat[0];
  const at = message.mes.lastIndexOf('\n', message.mes.indexOf('译文1-1'));
  const picture = '<bbi_image src="a.png"></bbi_image>';
  setFloor(message, `${message.mes.slice(0, at)}\n${picture}${message.mes.slice(at)}`);
  assert.match(await afterEdit(0), /改动没有碰到要翻译的原文，译文照旧/);
  assert.equal(requests.length, 1, 'no request for a picture');
  assert.ok(message.mes.includes(picture));
  assert.equal((await __testing.readMessageSnapshot(0, settings)).translated, true);

  // A translation line fixed by hand is kept.
  setFloor(message, message.mes.replace('译文1-3', '她笑了。'));
  assert.match(await afterEdit(0), /改动没有碰到要翻译的原文/);
  assert.equal(requests.length, 1);
  assert.ok(message.mes.includes('她笑了。'));

  // A changed original is translated again, the picture kept where it is.
  setFloor(message, message.mes.replace('彼女は笑った。', '彼女は泣いた。'));
  await afterEdit(0);
  assert.deepEqual(requests.at(-1), [1, 2, 3]);
  assert.ok(message.mes.includes('译文2-3'));
  assert.ok(message.mes.includes(picture));
  assert.equal((await __testing.readMessageSnapshot(0, settings)).translated, true);
});
