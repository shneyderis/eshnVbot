// Smoke test: runs the webhook handler end-to-end with fetch mocked.
const assert = require('node:assert');

process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.OPENAI_API_KEY = 'K';
process.env.TELEGRAM_WEBHOOK_SECRET = 'S';
process.env.ALLOWED_USER_IDS = '42';

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
assert.ok(bot.isAllowed(42) && !bot.isAllowed(7));
const long = 'слово '.repeat(2000).trim();
const parts = bot.chunk(long);
assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
assert.strictEqual(parts.join(' '), long);

// --- end-to-end with mocked network ---
const calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (url.includes('/getFile')) return json({ ok: true, result: { file_path: 'documents/file_0.opus' } });
  if (url.includes('/sendMessage') || url.includes('/sendChatAction')) return json({ ok: true, result: {} });
  if (url.includes('/file/bot')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
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

  // not allowed user
  calls.length = 0;
  res = mockRes();
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' },
    body: { message: { message_id: 1, chat: { id: 7 }, from: { id: 7 }, voice: { file_id: 'v' } } } }, res);
  const denied = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body));
  assert.strictEqual(denied.length, 1);
  assert.ok(denied[0].text.startsWith('Доступ закрыт'));
  assert.ok(!calls.some((c) => c.url.includes('openai.com')));

  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
