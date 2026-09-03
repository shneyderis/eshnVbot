// Smoke test: runs the webhook handler end-to-end with fetch mocked.
const assert = require('node:assert');

process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.OPENAI_API_KEY = 'K';
process.env.TELEGRAM_WEBHOOK_SECRET = 'S';
process.env.ALLOWED_USER_IDS = '42';
process.env.ADMIN_USER_IDS = '1';
process.env.JOIN_PASSWORD = 'sesame';
process.env.KV_REST_API_URL = 'https://redis.example';
process.env.KV_REST_API_TOKEN = 'R';

const bot = require('./api/telegram.js');

// --- unit helpers ---
assert.strictEqual(bot.uploadName('PTT-20250903-WA0001.opus'), 'audio.ogg');
assert.strictEqual(bot.uploadName('voice.ogg'), 'audio.ogg');
assert.strictEqual(bot.uploadName('a.m4a'), 'audio.m4a');
assert.strictEqual(bot.uploadName('noext', 'voice/file_1.oga'), 'audio.oga');
assert.strictEqual(bot.uploadName('weird.xyz'), 'audio.ogg');
assert.ok(bot.pickFile({ voice: { file_id: 'v' } }));
assert.ok(bot.pickFile({ document: { file_id: 'd', file_name: 'x.opus', mime_type: 'application/octet-stream' } }));
assert.strictEqual(bot.pickFile({ document: { file_id: 'd', file_name: 'x.pdf', mime_type: 'application/pdf' } }), null);
assert.strictEqual(bot.pickFile({ text: 'hi' }), null);
assert.ok(bot.isAdmin(1) && !bot.isAdmin(42));
const long = 'слово '.repeat(2000).trim();
const parts = bot.chunk(long);
assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
assert.strictEqual(parts.join(' '), long);

// --- end-to-end with mocked network ---
const calls = [];
// in-memory fake of the two Redis structures the bot uses
const redisUsers = {};
const redisBanned = new Set();
function fakeRedis([cmd, key, ...args]) {
  switch (cmd) {
    case 'HEXISTS': return key in redisUsers ? 0 : (args[0] in redisUsers ? 1 : 0);
    case 'HSET': redisUsers[args[0]] = args[1]; return 1;
    case 'HDEL': delete redisUsers[args[0]]; return 1;
    case 'HGETALL': return Object.entries(redisUsers).flat();
    case 'SISMEMBER': return redisBanned.has(args[0]) ? 1 : 0;
    case 'SADD': redisBanned.add(args[0]); return 1;
    case 'SREM': redisBanned.delete(args[0]); return 1;
    default: throw new Error('unexpected redis cmd ' + cmd);
  }
}
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (url === 'https://redis.example') {
    assert.strictEqual(opts.headers.authorization, 'Bearer R');
    return json({ result: fakeRedis(JSON.parse(opts.body)) });
  }
  if (url.includes('/getFile')) return json({ ok: true, result: { file_path: 'documents/file_0.opus' } });
  if (url.includes('/sendMessage') || url.includes('/sendChatAction')) return json({ ok: true, result: {} });
  if (url.includes('/file/bot')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  if (url.includes('chat/completions')) {
    const body = JSON.parse(opts.body);
    if (body.messages[0].content.startsWith('Summarize')) return json({ choices: [{ message: { content: '- тест' } }] });
    const target = /into (\w+)\./.exec(body.messages[0].content)[1];
    const content = target === 'Russian' ? '=' : 'Hello, this is a test.';
    return json({ choices: [{ message: { content } }] });
  }
  if (url.includes('openai.com')) {
    assert.ok(opts.body instanceof FormData);
    assert.strictEqual(opts.body.get('file').name, 'audio.ogg');
    assert.strictEqual(opts.body.get('model'), 'gpt-4o-transcribe');
    return { ok: true, status: 200, text: async () => 'Привет, это тест.\n' };
  }
  throw new Error('unexpected url ' + url);
};

function mockRes() {
  const res = { statusCode: 0, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

(async () => {
  // wrong secret
  let res = mockRes();
  await bot({ method: 'POST', headers: {}, body: {} }, res);
  assert.strictEqual(res.statusCode, 401);

  // forwarded WhatsApp voice as document
  const update = { message: { message_id: 10, chat: { id: 42 }, from: { id: 42 },
    document: { file_id: 'd1', file_name: 'PTT-20250903-WA0001.opus', mime_type: 'audio/ogg' } } };
  res = mockRes();
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' }, body: update }, res);
  assert.strictEqual(res.statusCode, 200);
  const sent = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'Привет, это тест.');
  assert.strictEqual(sent[0].reply_parameters.message_id, 10);

  // translation enabled: original + translation
  process.env.TRANSLATE_TO = 'English';
  calls.length = 0;
  res = mockRes();
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' }, body: update }, res);
  let msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['🎤 Привет, это тест.', '🌐 Hello, this is a test.']);

  // already in target language: no translation message
  process.env.TRANSLATE_TO = 'Russian';
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' }, body: update }, mockRes());
  msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['🎤 Привет, это тест.']);
  delete process.env.TRANSLATE_TO;

  // /tr as a reply
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' },
    body: { message: { message_id: 3, chat: { id: 42 }, from: { id: 42 }, text: '/tr English',
      reply_to_message: { message_id: 2, text: '🎤 Привет, это тест.' } } } }, mockRes());
  msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['Hello, this is a test.']);

  // summary: only for long transcripts
  process.env.SUMMARY = '1';
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' }, body: update }, mockRes());
  msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['Привет, это тест.']); // short: no summary
  process.env.SUMMARY_MIN_CHARS = '5';
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' }, body: update }, mockRes());
  msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['🎤 Привет, это тест.', '📝 - тест']);
  delete process.env.SUMMARY; delete process.env.SUMMARY_MIN_CHARS;

  // /sum as a reply
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' },
    body: { message: { message_id: 4, chat: { id: 42 }, from: { id: 42 }, text: '/sum',
      reply_to_message: { message_id: 2, text: '🎤 Привет, это тест.' } } } }, mockRes());
  msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['📝 - тест']);

  const send = (from, extra) => {
    calls.length = 0;
    return bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' },
      body: { message: { message_id: 1, chat: { id: from.id }, from, ...extra } } }, mockRes())
      .then(() => calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text));
  };
  const stranger = { id: 7, first_name: 'Ivan', username: 'ivan' };

  // unknown user: denied, OpenAI never called
  let out = await send(stranger, { voice: { file_id: 'v' } });
  assert.ok(out[0].startsWith('Нет доступа'));
  assert.ok(!calls.some((c) => c.url.includes('openai.com')));

  // wrong / right password
  out = await send(stranger, { text: '/join wrong' });
  assert.deepStrictEqual(out, ['Неверное кодовое слово.']);
  out = await send(stranger, { text: '/join sesame' });
  assert.deepStrictEqual(out, ['Доступ открыт. Присылай голосовые.']);
  out = await send(stranger, { voice: { file_id: 'v' } });
  assert.strictEqual(out[0], 'Привет, это тест.');

  // admin commands
  out = await send(stranger, { text: '/users' });
  assert.deepStrictEqual(out, ['Только для админа.']);
  out = await send({ id: 1 }, { text: '/users' });
  assert.ok(out[0].startsWith('Пользователи (1):') && out[0].includes('7 — Ivan (@ivan)'));
  out = await send({ id: 1 }, { text: '/ban 7' });
  assert.deepStrictEqual(out, ['7 удалён и заблокирован.']);
  out = await send(stranger, { text: '/join sesame' });
  assert.deepStrictEqual(out, ['Доступ закрыт.']);
  out = await send({ id: 1 }, { text: '/unban 7' });
  assert.ok(out[0].startsWith('7 разблокирован'));
  out = await send(stranger, { text: '/join sesame' });
  assert.deepStrictEqual(out, ['Доступ открыт. Присылай голосовые.']);
  out = await send({ id: 1 }, { text: '/ban abc' });
  assert.deepStrictEqual(out, ['Использование: /ban <id>']);

  // static allowlist still works without touching Redis
  out = await send({ id: 42 }, { voice: { file_id: 'v' } });
  assert.strictEqual(out[0], 'Привет, это тест.');

  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
