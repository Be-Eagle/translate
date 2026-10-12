// An isolated SillyTavern for trying 测试翻译 against the real host without touching anyone's own data.
//
//   node scripts/sandbox-tavern.mjs setup <SillyTavern folder> <sandbox folder>
//     Writes <sandbox>/config.yaml (port 8811, CORS proxy on, no browser launch, no extension
//     auto-update) and <sandbox>/data/default-user/settings.json: the chat connection on the local mock
//     (scripts/mock-services.mjs, port 8812), 测试翻译 translating every reply automatically and reading
//     aloud through the mock's Fish, every global third-party extension but 酒馆助手 switched off (the
//     global 测试翻译 too), a test character 美咲 with a small worldbook of her own. Nothing in the
//     SillyTavern folder is written.
//   node scripts/sandbox-tavern.mjs sync <sandbox folder>
//     Copies this repository's files (tracked, and new ones not ignored) into the sandbox user's
//     extensions folder as BeEagleTestTranslator-dev. A plain copy, never a link, so deleting the sandbox can
//     never reach the repository. The folder name differs from the global copy's because the host takes
//     a same-named extension from the global folder. Run it again after every change, then reload.
//
// Then start the two servers and open http://127.0.0.1:8811 :
//   node scripts/mock-services.mjs
//   node <SillyTavern folder>/server.js --configPath <sandbox>/config.yaml --dataRoot <sandbox>/data
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = 'http://127.0.0.1:8812';
const EXTENSION = 'BeEagleTestTranslator-dev';
const WORLD = '测试翻译测试';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// A character card the way SillyTavern reads one: a PNG (a plain 64×64 square here) whose tEXt chunk
// `chara` holds the card's JSON in base64.
function cardPng(card) {
  const size = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [0x25, 0x5d, 0x4e]).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const text = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1')]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('tEXt', text), pngChunk('IDAT', pixels), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// The test character. Her replies come from the mock (a Japanese scene in <story_scene>), whatever is said.
function testCard() {
  const fields = {
    name: '美咲',
    description: '美咲：二十岁的大学生，住在主角隔壁，性格开朗，喜欢读书和散步。',
    personality: '开朗、好奇、说话轻快',
    scenario: '傍晚，海边小镇星见町。',
    first_mes: '<story_scene>\n「こんばんは。今日はどうだった？」\n</story_scene>',
    mes_example: '',
  };
  return {
    ...fields,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...fields,
      creator_notes: '测试翻译沙盒的测试角色，回复由 scripts/mock-services.mjs 给出。',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['测试翻译测试'],
      creator: '',
      character_version: '1',
      extensions: { world: WORLD },
    },
  };
}

function setup(stFolder, sandbox) {
  if (!stFolder || !sandbox) throw new Error('用法：node scripts/sandbox-tavern.mjs setup <SillyTavern 目录> <沙盒目录>');
  const st = path.resolve(stFolder);
  const out = path.resolve(sandbox);
  if (!fs.existsSync(path.join(st, 'server.js'))) throw new Error(`${st} 里没有 server.js，不是 SillyTavern 的目录。`);
  if (out === st || out.startsWith(st + path.sep)) throw new Error('沙盒目录不能放在 SillyTavern 目录里面。');
  fs.mkdirSync(out, { recursive: true });

  let yaml = fs.readFileSync(path.join(st, 'default/config.yaml'), 'utf8');
  const set = (pattern, replacement) => {
    if (!pattern.test(yaml)) throw new Error('default/config.yaml 里没有 ' + pattern);
    yaml = yaml.replace(pattern, replacement);
  };
  set(/^port: 8000$/m, 'port: 8811');
  set(/^enableCorsProxy: false$/m, 'enableCorsProxy: true');
  set(/^(browserLaunch:\r?\n(?:[ \t]*#.*\r?\n)*[ \t]*enabled:) true$/m, '$1 false');
  set(/^(extensions:\r?\n(?:[ \t]*#.*\r?\n|[ \t]+enabled:.*\r?\n)*[ \t]*autoUpdate:) true/m, '$1 false');
  fs.writeFileSync(path.join(out, 'config.yaml'), yaml);

  const user = path.join(out, 'data/default-user');
  fs.mkdirSync(path.join(user, 'worlds'), { recursive: true });
  fs.mkdirSync(path.join(user, 'characters'), { recursive: true });
  fs.mkdirSync(path.join(user, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(user, 'characters/美咲.png'), cardPng(testCard()));

  const settings = JSON.parse(fs.readFileSync(path.join(st, 'default/content/settings.json'), 'utf8'));
  // The host's first-run onboarding (pick a persona name first) would hold the page until answered.
  settings.firstRun = false;
  settings.username = '玩家';
  settings.main_api = 'openai';
  settings.oai_settings = Object.assign({}, settings.oai_settings, {
    chat_completion_source: 'custom',
    custom_url: MOCK + '/v1',
    custom_model: 'mock-chat',
    stream_openai: true,
  });
  settings.extension_settings = settings.extension_settings || {};
  settings.extension_settings['beagle-test-translator'] = {
    autoGeneration: true,
    autoSwipe: true,
    tts: {
      enabled: true,
      provider: 'fish',
      streamVoice: 'fish',
      fish: { key: 'mock-key', baseUrl: MOCK, viaProxy: false, model: 's2-pro', format: 'mp3' },
    },
  };
  const thirdPartyFolder = path.join(st, 'public/scripts/extensions/third-party');
  const thirdParty = fs.existsSync(thirdPartyFolder)
    ? fs.readdirSync(thirdPartyFolder, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'JS-Slash-Runner')
      .map(entry => 'third-party/' + entry.name)
    : [];
  settings.extension_settings.disabledExtensions = thirdParty;
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify(settings, null, 2));

  const entry = (uid, name, keys, content) => ({
    uid, key: keys, keysecondary: [], comment: name, content,
    constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
    order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
    probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '',
    role: null, sticky: 0, cooldown: 0, delay: 0, displayIndex: uid,
  });
  const world = {
    entries: {
      0: entry(0, '美咲', ['美咲', 'Misaki'], '美咲：二十岁的大学生，住在主角隔壁，性格开朗，喜欢读书和散步。说话轻快，常用「ね」结尾。'),
      1: entry(1, '老周', ['老周'], '老周：五十岁的书店老板，沉稳寡言，是美咲打工的书店店主。'),
      2: entry(2, '星见町', ['星见町'], '星见町：故事发生的海边小镇，有一条商店街和一座灯塔。'),
    },
  };
  fs.writeFileSync(path.join(user, `worlds/${WORLD}.json`), JSON.stringify(world, null, 2));
  console.log(`沙盒已建好：${out}（测试角色「美咲」；停用了 ${thirdParty.length} 个全局第三方扩展）`);
  console.log('下一步：node scripts/sandbox-tavern.mjs sync ' + sandbox);
}

function sync(sandbox) {
  if (!sandbox) throw new Error('用法：node scripts/sandbox-tavern.mjs sync <沙盒目录>');
  const target = path.join(path.resolve(sandbox), 'data/default-user/extensions', EXTENSION);
  if (!fs.existsSync(path.dirname(target))) throw new Error(`${path.dirname(target)} 不存在，先运行 setup。`);
  const files = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean)
    .filter(file => fs.existsSync(path.join(repo, file)) && fs.statSync(path.join(repo, file)).isFile());
  let copied = 0;
  for (const file of files) {
    const from = path.join(repo, file);
    const to = path.join(target, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const same = fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size && fs.readFileSync(to).equals(fs.readFileSync(from));
    if (!same) {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
  console.log(`同步了 ${copied} 个文件（共 ${files.length} 个）到 ${target}；刷新酒馆页面生效。`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'setup') setup(...rest);
  else if (command === 'sync') sync(...rest);
  else throw new Error('用法：node scripts/sandbox-tavern.mjs setup <SillyTavern 目录> <沙盒目录>\n　　　node scripts/sandbox-tavern.mjs sync <沙盒目录>');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
