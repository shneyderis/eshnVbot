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
const callResult = require('./api/call-result.js');
const callsLib = require('./lib/calls.js');

// --- unit helpers ---
assert.strictEqual(bot.uploadName('PTT-20250903-WA0001.opus'), 'audio.ogg');
assert.strictEqual(bot.uploadName('voice.ogg'), 'audio.ogg');
assert.strictEqual(bot.uploadName('a.m4a'), 'audio.m4a');
assert.strictEqual(bot.uploadName('noext', 'voice/file_1.oga'), 'audio.oga');
assert.strictEqual(bot.uploadName('weird.xyz'), 'audio.ogg');
assert.ok(bot.pickFile({ voice: { file_id: 'v' } }));
assert.strictEqual(bot.uploadName(bot.pickFile({ video: { file_id: 'x', mime_type: 'video/mp4' } }).name), 'audio.mp4');
assert.ok(bot.pickFile({ document: { file_id: 'd', file_name: 'x.opus', mime_type: 'application/octet-stream' } }));
assert.strictEqual(bot.pickFile({ document: { file_id: 'd', file_name: 'x.pdf', mime_type: 'application/pdf' } }), null);
assert.strictEqual(bot.pickFile({ text: 'hi' }), null);
assert.strictEqual(bot.pickImage({ photo: [{ file_id: 'small' }, { file_id: 'big' }] }).fileId, 'big');
assert.ok(bot.pickImage({ document: { file_id: 'd', file_name: 'scan.png', mime_type: 'image/png' } }));
assert.strictEqual(bot.pickImage({ document: { file_id: 'd', file_name: 'x.opus', mime_type: 'audio/ogg' } }), null);
assert.ok(bot.isAdmin(1) && !bot.isAdmin(42));
assert.strictEqual(bot.langName('ru'), 'Russian');
assert.strictEqual(bot.langName(' Иврит '), 'Hebrew');
assert.strictEqual(bot.langName('Spanish'), 'Spanish');
const long = 'слово '.repeat(2000).trim();
const parts = bot.chunk(long);
assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
assert.strictEqual(parts.join(' '), long);

// --- outbound calls: unit helpers ---
assert.strictEqual(callsLib.normalizeNumber('+81 (3) 1234-5678'), '+81312345678');
assert.strictEqual(callsLib.normalizeNumber('0034 931 234 567'), '+34931234567');
assert.strictEqual(callsLib.normalizeNumber('931234567'), ''); // no country code
assert.strictEqual(callsLib.normalizeNumber('112'), '');
assert.strictEqual(callsLib.leadingNumber('+34 931 234 567 запиши меня'), '+34931234567');
assert.strictEqual(callsLib.leadingNumber('запиши меня, номер +34931234567'), '');
{
  const body = '{"type":"x"}';
  const now = 1700000000;
  const header = callsLib.sign(body, 'whsec', now);
  assert.ok(callsLib.verifySignature(body, header, 'whsec', now));
  assert.ok(!callsLib.verifySignature(body + ' ', header, 'whsec', now)); // body changed
  assert.ok(!callsLib.verifySignature(body, header, 'other', now)); // wrong secret
  assert.ok(!callsLib.verifySignature(body, header, 'whsec', now + 3600)); // too old
  assert.ok(!callsLib.verifySignature(body, 't=1,v0=zz', 'whsec', now));
  assert.ok(!callsLib.verifySignature(body, undefined, 'whsec', now));
}
assert.strictEqual(
  callsLib.formatTranscript([{ role: 'agent', message: 'Hola' }, { role: 'user', message: ' Sí ' }, { role: 'agent', message: null }]),
  'Бот: Hola\nСобеседник: Sí',
);
assert.ok(!callsLib.heardAnyone([{ role: 'agent', message: 'Hola' }]));
assert.strictEqual(
  callsLib.failureText({ failure_reason: 'busy', metadata: { type: 'sip', body: { sip_status_code: 486, sip_status: 'Busy here' } } }),
  'занято (SIP 486 Busy here)',
);

// --- end-to-end with mocked network ---
const calls = [];
let dialed = 0;
let spoken = 'Привет, это тест.\n'; // what the mocked speech recognition "hears"
let redisDown = false;
const unlocked = new Set(); // plan messages whose buttons were already removed
// in-memory fake of the two Redis structures the bot uses
const redisHashes = { users: {}, contacts: {} };
const redisBanned = new Set();
const redisKV = {}; // plain keys used by /call
function fakeRedis([cmd, key, ...args]) {
  const redisUsers = redisHashes[key] || {};
  switch (cmd) {
    case 'SET':
      if (args.includes('NX') && key in redisKV) return null;
      redisKV[key] = args[0];
      return 'OK';
    case 'GET': return key in redisKV ? redisKV[key] : null;
    case 'GETDEL': { const v = key in redisKV ? redisKV[key] : null; delete redisKV[key]; return v; }
    case 'DEL': delete redisKV[key]; return 1;
    case 'HEXISTS': return args[0] in redisUsers ? 1 : 0;
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
    if (redisDown) throw new TypeError('fetch failed'); // e.g. the database was archived
    assert.strictEqual(opts.headers.authorization, 'Bearer R');
    return json({ result: fakeRedis(JSON.parse(opts.body)) });
  }
  if (url.includes('/getFile')) return json({ ok: true, result: { file_path: 'documents/file_0.opus' } });
  if (url.includes('/sendMessage') || url.includes('/sendChatAction') || url.includes('/setMyCommands')) return json({ ok: true, result: {} });
  if (url.includes('/answerCallbackQuery') || url.includes('/editMessageText')) return json({ ok: true, result: {} });
  if (url.includes('/editMessageReplyMarkup')) {
    // like Telegram: removing buttons that are already gone is an error
    const id = JSON.parse(opts.body).message_id;
    if (unlocked.has(id)) return json({ ok: false, description: 'Bad Request: message is not modified' });
    unlocked.add(id);
    return json({ ok: true, result: {} });
  }
  if (url === 'https://api.openai.com/v1/responses') {
    const body = JSON.parse(opts.body);
    assert.deepStrictEqual(body.tools, [{ type: 'web_search' }]);
    assert.ok(body.input.includes('Place: Disfrutar') && body.input.includes('Location: Barcelona'));
    return json({ output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: 'Here it is:\n{"name":"Disfrutar","phone":"+34 933 48 68 96","address":"C/ de Villarroel 163, Barcelona","source_url":"https://example.com/disfrutar"}' }] },
    ] });
  }
  if (url.includes('elevenlabs.io')) {
    assert.strictEqual(opts.headers['xi-api-key'], 'EL');
    dialed += 1; // each started call gets its own conversation id, like the real API
    return json({ success: true, message: 'ok', conversation_id: `conv_${dialed}`, sip_call_id: `sip_${dialed}` });
  }
  if (url.includes('/file/bot')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  if (url.includes('chat/completions')) {
    const body = JSON.parse(opts.body);
    if (body.messages[0].content.startsWith('Summarize')) return json({ choices: [{ message: { content: '- тест' } }] });
    if (body.messages[0].content.startsWith('Extract all text')) {
      const img = body.messages[1].content.find((c) => c.type === 'image_url');
      assert.ok(img.image_url.url.startsWith('data:image/jpeg;base64,'));
      return json({ choices: [{ message: { content: img.image_url.url.endsWith('AQID') ? 'Текст с картинки' : 'NO_TEXT' } }] });
    }
    if (body.messages[0].content.startsWith('Report on a phone call')) {
      assert.ok(body.messages[1].content.includes('Собеседник: Sí, mañana a las 10.'));
      return json({ choices: [{ message: { content: 'Итог: цель достигнута.\n- Запись на завтра, 10:00' } }] });
    }
    assert.deepStrictEqual(body.response_format, { type: 'json_object' });
    if (body.messages[0].content.startsWith('You prepare a phone call')) {
      const noNumber = !/\d{3}/.test(body.messages[1].content);
      const byName = body.messages[1].content.includes('Disfrutar');
      return json({ choices: [{ message: { content: JSON.stringify({
        place_name: byName ? 'Disfrutar' : '', place_location: byName ? 'Barcelona' : '',
        to_number: noNumber ? '' : '+34 931 234 567', language: 'es', language_name_ru: 'испанский', language_name_en: 'Spanish',
        callee_ru: 'клиника', goal_ru: 'Записаться к терапевту на завтра утром.',
        first_message: 'Hola, soy un asistente de IA y llamo de parte de Eugene.',
        task: 'Book a GP appointment for tomorrow morning.', missing_ru: ['дата рождения'],
      }) } }] });
    }
    const target = /Target language: (\w+)\./.exec(body.messages[0].content)[1];
    const content = target === 'Russian'
      ? JSON.stringify({ source_language: 'Russian', already_target: true, translation: '' })
      : JSON.stringify({ source_language: 'Russian', already_target: false, translation: 'Hello, this is a test.' });
    return json({ choices: [{ message: { content } }] });
  }
  if (url.includes('openai.com')) {
    assert.ok(opts.body instanceof FormData);
    assert.strictEqual(opts.body.get('file').name, 'audio.ogg');
    assert.strictEqual(opts.body.get('model'), 'gpt-4o-transcribe');
    return { ok: true, status: 200, text: async () => spoken };
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
  process.env.TRANSLATE_TO = 'ru';
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' }, body: update }, mockRes());
  msgs = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => JSON.parse(c.opts.body).text);
  assert.deepStrictEqual(msgs, ['🎤 Привет, это тест.']);
  delete process.env.TRANSLATE_TO;

  // /tr as a reply
  calls.length = 0;
  await bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' },
    body: { message: { message_id: 3, chat: { id: 42 }, from: { id: 42 }, text: '/tr en',
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

  // photo: text is read from the image, then translated like a voice note
  process.env.TRANSLATE_TO = 'English';
  out = await send({ id: 42 }, { photo: [{ file_id: 'small' }, { file_id: 'big' }] });
  assert.deepStrictEqual(out, ['🖼 Текст с картинки', '🌐 Hello, this is a test.']);
  delete process.env.TRANSLATE_TO;

  // /help: admin sees admin section, others don't; command menu registered
  out = await send({ id: 1 }, { text: '/help' });
  assert.ok(out[0].includes('/tr <язык>') && out[0].includes('/ban <id>') && out[0].includes('id: 1'));
  assert.ok(calls.some((c) => c.url.includes('/setMyCommands')));
  // the admin's own chat gets /call and friends in the menu; the default menu stays without them
  let menus = calls.filter((c) => c.url.includes('/setMyCommands')).map((c) => JSON.parse(c.opts.body));
  assert.strictEqual(menus.length, 2);
  assert.ok(!menus.find((m) => !m.scope).commands.some((c) => c.command === 'call'));
  const adminMenu = menus.find((m) => m.scope);
  assert.deepStrictEqual(adminMenu.scope, { type: 'chat', chat_id: 1 });
  assert.deepStrictEqual(adminMenu.commands.slice(0, 3).map((c) => c.command), ['call', 'contacts', 'forget']);
  out = await send(stranger, { text: '/start' });
  assert.ok(out[0].includes('/join') && !out[0].includes('/ban'));
  menus = calls.filter((c) => c.url.includes('/setMyCommands')).map((c) => JSON.parse(c.opts.body));
  assert.ok(menus.length === 1 && !menus[0].scope);

  // oversized file is rejected before download
  out = await send({ id: 42 }, { video: { file_id: 'x', file_size: 30 * 1024 * 1024 } });
  assert.ok(out[0].startsWith('Файл больше 20 МБ'));
  assert.ok(!calls.some((c) => c.url.includes('/getFile')));

  // static allowlist still works without touching Redis
  out = await send({ id: 42 }, { voice: { file_id: 'v' } });
  assert.strictEqual(out[0], 'Привет, это тест.');

  // ---------- /call ----------
  const tgCalls = (method) => calls.filter((c) => c.url.includes('/' + method)).map((c) => JSON.parse(c.opts.body));
  let planMessageId = 100;
  const press = (from, data, text, messageId = ++planMessageId) => {
    calls.length = 0;
    return bot({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'S' },
      body: { callback_query: { id: 'cb', from, data,
        message: { message_id: messageId, chat: { id: from.id }, text, reply_to_message: { message_id: 5 } } } } }, mockRes());
  };

  // only the admin may call
  out = await send({ id: 42 }, { text: '/call +34931234567 запиши меня к терапевту' });
  assert.deepStrictEqual(out, ['Только для админа.']);

  // not configured yet
  out = await send({ id: 1 }, { text: '/call +34931234567 запиши меня к терапевту' });
  assert.ok(out[0].startsWith('Звонки не настроены') && out[0].includes('ELEVENLABS_API_KEY'));
  process.env.ELEVENLABS_API_KEY = 'EL';
  process.env.ELEVENLABS_AGENT_ID = 'agent_1';
  process.env.ELEVENLABS_PHONE_NUMBER_ID = 'phnum_1';
  process.env.ELEVENLABS_WEBHOOK_SECRET = 'whsec';
  process.env.CALL_ON_BEHALF_OF = 'Eugene';

  out = await send({ id: 1 }, { text: '/call' });
  assert.ok(out[0].startsWith('Напиши задание с номером или названием места'));
  out = await send({ id: 1 }, { text: '/call запиши меня к терапевту' });
  assert.ok(out[0].startsWith('Не нашёл номер'));

  // plan is shown with buttons; nothing is dialed before the tap
  out = await send({ id: 1 }, { text: '/call +34931234567 запиши меня к терапевту завтра утром' });
  assert.ok(out[0].includes('Номер: +34931234567') && out[0].includes('Язык: испанский') && out[0].includes('• дата рождения'));
  assert.ok(!calls.some((c) => c.url.includes('elevenlabs.io')));
  const buttons = tgCalls('sendMessage')[0].reply_markup.inline_keyboard[0];
  assert.deepStrictEqual(buttons.map((b) => b.text), ['✅ Звонить', '❌ Отмена']);
  const goData = buttons[0].callback_data;
  assert.strictEqual(goData, 'call:go');
  assert.ok(out[0].includes('Задание агенту:\nBook a GP appointment for tomorrow morning.'));

  // a non-admin cannot press the button
  await press({ id: 42 }, goData, out[0]);
  assert.ok(!calls.some((c) => c.url.includes('elevenlabs.io')));
  assert.strictEqual(tgCalls('answerCallbackQuery')[0].text, 'Только для админа.');

  // admin confirms: ElevenLabs is asked to dial with the plan read back from the message
  await press({ id: 1 }, goData, out[0], 500);
  const dial = calls.filter((c) => c.url.includes('elevenlabs.io'));
  assert.strictEqual(dial.length, 1);
  assert.strictEqual(dial[0].url, 'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call');
  const dialBody = JSON.parse(dial[0].opts.body);
  assert.strictEqual(dialBody.agent_id, 'agent_1');
  assert.strictEqual(dialBody.agent_phone_number_id, 'phnum_1');
  assert.strictEqual(dialBody.to_number, '+34931234567');
  const override = dialBody.conversation_initiation_client_data.conversation_config_override.agent;
  assert.strictEqual(override.language, 'es');
  assert.ok(!('first_message' in override)); // not available on every ElevenLabs plan: the opening is in the prompt
  assert.ok(override.prompt.prompt.includes('Hola, soy un asistente de IA y llamo de parte de Eugene.'));
  assert.ok(override.prompt.prompt.includes('Book a GP appointment') && override.prompt.prompt.includes('on behalf of Eugene'));
  assert.ok(override.prompt.prompt.includes('Never give or take payment card details'));
  assert.deepStrictEqual(dialBody.conversation_initiation_client_data.dynamic_variables, {
    tg_chat_id: '1', tg_reply_to: '5', call_number: '+34931234567', call_task: 'Book a GP appointment for tomorrow morning.',
  });
  assert.ok(tgCalls('editMessageText')[0].text.endsWith('Звоню. Итог и расшифровку пришлю сюда.'));

  // second tap on the same message does not dial again
  await press({ id: 1 }, goData, out[0], 500);
  assert.ok(!calls.some((c) => c.url.includes('elevenlabs.io')));
  assert.strictEqual(tgCalls('answerCallbackQuery')[0].text, 'Уже обработано.');

  // a message that is not a plan is never dialed
  await press({ id: 1 }, goData, 'Номер: +34931234567\nпросто текст');
  assert.ok(!calls.some((c) => c.url.includes('elevenlabs.io')));
  assert.ok(tgCalls('editMessageText')[0].text.endsWith('Не смог прочитать план. Отправь /call ещё раз.'));

  // cancel
  out = await send({ id: 1 }, { text: '/call +34931234567 запиши меня к терапевту' });
  await press({ id: 1 }, tgCalls('sendMessage')[0].reply_markup.inline_keyboard[0][1].callback_data, out[0]);
  assert.ok(!calls.some((c) => c.url.includes('elevenlabs.io')));
  assert.ok(tgCalls('editMessageText')[0].text.endsWith('Отменено.'));

  // /call as a reply to a transcribed voice note takes the brief from that message
  out = await send({ id: 1 }, { text: '/call', reply_to_message: { message_id: 5, text: '🎤 Позвони в клинику +34 931 234 567 и запиши меня' } });
  assert.ok(out[0].includes('Номер: +34931234567'));

  // ---------- call brief by voice ----------
  const hasPlan = () => tgCalls('sendMessage').some((m) => m.reply_markup);
  spoken = 'Позвони в клинику +34 931 234 567 и запиши меня к терапевту.\n';
  out = await send({ id: 1 }, { voice: { file_id: 'v' } });
  assert.strictEqual(out[0], '🎤 Позвони в клинику +34 931 234 567 и запиши меня к терапевту.');
  assert.ok(out[1].includes('Номер: +34931234567') && hasPlan());
  assert.ok(!calls.some((c) => c.url.includes('elevenlabs.io'))); // still waits for the button

  // a forwarded voice note is somebody else's words: transcript only
  out = await send({ id: 1 }, { voice: { file_id: 'v' }, forward_origin: { type: 'user' } });
  assert.deepStrictEqual(out, ['Позвони в клинику +34 931 234 567 и запиши меня к терапевту.']);
  assert.ok(!hasPlan());

  // not the admin: transcript only
  out = await send({ id: 42 }, { voice: { file_id: 'v' } });
  assert.ok(out.length === 1 && !hasPlan());

  // an uploaded audio file is not a brief either
  out = await send({ id: 1 }, { audio: { file_id: 'v', file_name: 'audio.ogg' } });
  assert.ok(out.length === 1 && !hasPlan());

  // the admin's ordinary voice note is transcribed as before
  spoken = 'Привет, это тест.\n';
  out = await send({ id: 1 }, { voice: { file_id: 'v' } });
  assert.deepStrictEqual(out, ['Привет, это тест.']);
  assert.ok(bot.isCallBrief({ voice: {}, from: { id: 1 } }, 'набери ресторан'));
  assert.ok(!bot.isCallBrief({ voice: {}, from: { id: 1 } }, 'Мне позвонили из банка'));
  assert.ok(!bot.isCallBrief({ voice: {}, from: { id: 1 } }, 'called him yesterday'));

  // ---------- /call by name ----------
  const usedWebSearch = () => calls.some((c) => c.url === 'https://api.openai.com/v1/responses');
  out = await send({ id: 1 }, { text: '/call позвони в ресторан Disfrutar в Барселоне, стол на двоих' });
  assert.ok(usedWebSearch());
  assert.ok(out[0].includes('Номер: +34933486896') && out[0].includes('Номер найден в интернете, проверь: Disfrutar, C/ de Villarroel 163, Barcelona'));
  assert.ok(out[0].includes('Источник: https://example.com/disfrutar'));
  assert.deepStrictEqual(redisHashes.contacts, {}); // nothing is remembered before the call is confirmed

  // confirmed: dials through Twilio when configured so, and remembers the number
  process.env.ELEVENLABS_TELEPHONY = 'twilio';
  await press({ id: 1 }, tgCalls('sendMessage')[0].reply_markup.inline_keyboard[0][0].callback_data, out[0]);
  const byName = calls.filter((c) => c.url.includes('elevenlabs.io'));
  assert.strictEqual(byName[0].url, 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
  assert.strictEqual(JSON.parse(byName[0].opts.body).to_number, '+34933486896');
  delete process.env.ELEVENLABS_TELEPHONY;
  assert.strictEqual(JSON.parse(redisHashes.contacts.disfrutar).number, '+34933486896');

  // next time the number comes from the saved contacts, without a web search
  out = await send({ id: 1 }, { text: '/call позвони в Disfrutar, перенеси бронь' });
  assert.ok(!usedWebSearch());
  assert.ok(out[0].includes('Номер: +34933486896 (из базы: Disfrutar)'));

  out = await send({ id: 1 }, { text: '/contacts' });
  assert.deepStrictEqual(out, ['Номера (1):\nDisfrutar — +34933486896 — C/ de Villarroel 163, Barcelona']);
  out = await send({ id: 42 }, { text: '/contacts' });
  assert.deepStrictEqual(out, ['Только для админа.']);
  out = await send({ id: 1 }, { text: '/forget disfrutar' });
  assert.deepStrictEqual(out, ['Забыл: Disfrutar — +34933486896.']);
  out = await send({ id: 1 }, { text: '/contacts' });
  assert.deepStrictEqual(out, ['Пока ничего не запомнил.']);

  // ---------- result webhook ----------
  const { Readable } = require('node:stream');
  const hook = (payload, signature) => {
    calls.length = 0;
    const raw = JSON.stringify(payload);
    const req = Readable.from([Buffer.from(raw)]);
    req.method = 'POST';
    req.headers = { 'elevenlabs-signature': signature === undefined ? callsLib.sign(raw, 'whsec') : signature };
    const r = mockRes();
    return callResult(req, r).then(() => ({ status: r.statusCode, body: r.body, texts: tgCalls('sendMessage').map((m) => m.text) }));
  };
  const done = { type: 'post_call_transcription', event_timestamp: 1, data: {
    agent_id: 'agent_1', conversation_id: 'conv_1', status: 'done',
    transcript: [
      { role: 'agent', message: 'Hola, soy un asistente de IA y llamo de parte de Eugene.' },
      { role: 'user', message: 'Sí, mañana a las 10.' },
    ],
    metadata: { call_duration_secs: 75 },
    conversation_initiation_client_data: { dynamic_variables: {
      tg_chat_id: '1', tg_reply_to: '5', call_number: '+34931234567', call_task: 'Записаться к терапевту.', system__agent_id: 'agent_1',
    } },
  } };

  let hooked = await hook(done, 't=1,v0=' + '0'.repeat(64));
  assert.strictEqual(hooked.status, 401);
  assert.deepStrictEqual(hooked.texts, []);

  hooked = await hook(done);
  assert.strictEqual(hooked.status, 200);
  assert.strictEqual(hooked.texts.length, 2);
  assert.ok(hooked.texts[0].startsWith('📞 Звонок на +34931234567 завершён, 1:15.') && hooked.texts[0].includes('Итог: цель достигнута.'));
  assert.ok(hooked.texts[1].startsWith('🎤 Бот: Hola') && hooked.texts[1].includes('Собеседник: Sí, mañana a las 10.'));
  assert.strictEqual(tgCalls('sendMessage')[0].chat_id, '1');
  assert.strictEqual(tgCalls('sendMessage')[0].reply_parameters.message_id, 5);

  // ElevenLabs retry of the same event is not reported twice
  hooked = await hook(done);
  assert.strictEqual(hooked.body, 'duplicate');
  assert.deepStrictEqual(hooked.texts, []);

  // nobody spoke: no model call, plain note
  hooked = await hook({ ...done, data: { ...done.data, conversation_id: 'conv_unknown', transcript: [done.data.transcript[0]] } });
  assert.ok(hooked.texts[0].includes('Собеседника не было слышно'));
  assert.ok(!calls.some((c) => c.url.includes('chat/completions')));

  // a result without our variables goes to the first admin
  hooked = await hook({ ...done, data: { ...done.data, conversation_id: 'conv_foreign', conversation_initiation_client_data: {} } });
  assert.strictEqual(tgCalls('sendMessage')[0].chat_id, '1');
  assert.ok(hooked.texts[0].startsWith('📞 Звонок завершён, 1:15.'));

  // call never connected
  hooked = await hook({ type: 'call_initiation_failure', event_timestamp: 1, data: { agent_id: 'agent_1', conversation_id: 'conv_1',
    failure_reason: 'busy', metadata: { type: 'sip', body: { to_number: '+34931234567', sip_status_code: 486, sip_status: 'Busy here' } } } });
  assert.deepStrictEqual(hooked.texts, ['📞 Не дозвонился на +34931234567: занято (SIP 486 Busy here).']);

  // ---------- the store is down (archived database): calls still work ----------
  redisDown = true;
  out = await send({ id: 1 }, { text: '/call +34931234567 запиши меня к терапевту завтра утром' });
  assert.ok(out[0].includes('Номер: +34931234567') && hasPlan());
  await press({ id: 1 }, 'call:go', out[0]);
  assert.strictEqual(calls.filter((c) => c.url.includes('elevenlabs.io')).length, 1);
  out = await send({ id: 1 }, { text: '/call позвони в ресторан Disfrutar в Барселоне' });
  assert.ok(usedWebSearch() && out[0].includes('Номер: +34933486896'));
  hooked = await hook({ ...done, data: { ...done.data, conversation_id: 'conv_down' } });
  assert.strictEqual(hooked.texts.length, 2);
  redisDown = false;

  // other event types are acknowledged and ignored
  hooked = await hook({ type: 'post_call_audio', data: { conversation_id: 'conv_1' } });
  assert.strictEqual(hooked.body, 'ignored');

  // without the secret nothing is processed
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  hooked = await hook(done);
  assert.strictEqual(hooked.status, 503);

  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
