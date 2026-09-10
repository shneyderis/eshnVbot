// Telegram webhook: receives a voice/audio message (e.g. forwarded from WhatsApp),
// transcribes it with OpenAI and replies with the text.
//
// Env vars (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN       token from @BotFather (required)
//   OPENAI_API_KEY           OpenAI API key (required)
//   TELEGRAM_WEBHOOK_SECRET  any random string; must match the one passed to setWebhook (recommended)
//   ADMIN_USER_IDS           comma-separated Telegram user ids of admins (always allowed; can run /users, /ban, /unban)
//   ALLOWED_USER_IDS         comma-separated Telegram user ids always allowed (optional static list)
//   JOIN_PASSWORD            code word for self-registration via "/join <word>" (needs Redis, see lib/store.js)
//   KV_REST_API_URL / KV_REST_API_TOKEN   Upstash Redis (added automatically by Vercel Marketplace)
//   TRANSCRIBE_MODEL         default "gpt-4o-transcribe" (alternative: "whisper-1")
//   TRANSCRIBE_LANGUAGE      optional ISO-639-1 hint ("ru", "uk", "en"); default: auto-detect
//   TRANSLATE_TO             optional target language ("ru", "Russian", "en"...); when set, every
//                            transcript is followed by a translation (skipped if already in that language)
//   TRANSLATE_MODEL          default "gpt-4o-mini" (also used for summaries and reading text from images)
//   SUMMARY                  "1" to follow every transcript with a short summary
//   SUMMARY_MIN_CHARS        only summarize transcripts longer than this (default 300)
//
// Commands: /start, /help, /join <word>; as a reply to a bot message: /tr <lang> translates it, /sum summarizes it.
// Admin: /users, /ban <id>, /unban <id>.
//
// Access rule: if no ADMIN_USER_IDS, ALLOWED_USER_IDS and no Redis are configured, everyone is allowed.
// Otherwise a user must be an admin, in ALLOWED_USER_IDS, or registered via /join (and not banned).

const store = require('../lib/store');

const TG_API = 'https://api.telegram.org';
const OPENAI_API = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_API = 'https://api.openai.com/v1/chat/completions';
const SAME_LANGUAGE = '=';
const TG_MAX_MESSAGE = 4096;
// Extensions accepted by the OpenAI transcription endpoint.
const OPENAI_EXTS = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);
const EXT_ALIASES = { opus: 'ogg', aac: 'm4a', caf: 'm4a', amr: 'ogg', '3gp': 'mp4', mov: 'mp4' };

function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || r.status}`);
    return data.result;
  });
}

function sendText(chatId, text, replyTo) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
  });
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const NO_TEXT = 'NO_TEXT';

// Pick the image attachment from a Telegram message, if any (largest photo size).
function pickImage(msg) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { fileId: best.file_id, mime: 'image/jpeg' };
  }
  if (msg.document) {
    const d = msg.document;
    const mime = d.mime_type || '';
    if (mime.startsWith('image/') || IMAGE_EXTS.has(extOf(d.file_name || ''))) {
      return { fileId: d.file_id, mime: mime || 'image/jpeg' };
    }
  }
  return null;
}

// Pick the audio-bearing attachment from a Telegram message, if any.
function pickFile(msg) {
  if (msg.voice) return { fileId: msg.voice.file_id, name: 'voice.ogg', mime: msg.voice.mime_type };
  if (msg.audio) return { fileId: msg.audio.file_id, name: msg.audio.file_name || 'audio.mp3', mime: msg.audio.mime_type };
  if (msg.video_note) return { fileId: msg.video_note.file_id, name: 'note.mp4', mime: 'video/mp4' };
  if (msg.document) {
    const d = msg.document;
    const mime = d.mime_type || '';
    const ext = extOf(d.file_name || '');
    if (mime.startsWith('audio/') || mime.startsWith('video/') || OPENAI_EXTS.has(ext) || ext in EXT_ALIASES) {
      return { fileId: d.file_id, name: d.file_name || 'file.ogg', mime };
    }
  }
  return null;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

// Name the upload so OpenAI accepts it (it validates by extension).
function uploadName(name, telegramPath) {
  let ext = extOf(name) || extOf(telegramPath || '');
  ext = EXT_ALIASES[ext] || ext;
  if (!OPENAI_EXTS.has(ext)) ext = 'ogg';
  return `audio.${ext}`;
}

function chunk(text, size = TG_MAX_MESSAGE) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

const HELP = [
  'Что умею:',
  '• Перешли голосовое, аудио или картинку с текстом — верну текст.',
  '  Из WhatsApp: зажать сообщение → Переслать → Поделиться → Telegram → этот чат.',
  '',
  'Команды (ответом на сообщение бота: свайп влево или зажать → Ответить):',
  '/tr <язык> — перевести. Например: /tr en, /tr ru, /tr Spanish',
  '/sum — короткий пересказ без воды',
  '',
  '/join <кодовое слово> — получить доступ',
  '/help — эта подсказка',
].join('\n');

const ADMIN_HELP = [
  '',
  'Админ:',
  '/users — кто зарегистрирован',
  '/ban <id> — удалить и заблокировать',
  '/unban <id> — разблокировать',
].join('\n');

// Command menu shown by Telegram under the "/" button. Best effort, ignored on failure.
function registerCommands() {
  return tg('setMyCommands', {
    commands: [
      { command: 'help', description: 'Что умею и команды' },
      { command: 'tr', description: 'Перевести (ответом на сообщение): /tr en' },
      { command: 'sum', description: 'Короткий пересказ (ответом на сообщение)' },
      { command: 'join', description: 'Получить доступ: /join кодовое слово' },
    ],
  }).catch(() => {});
}

function idList(name) {
  return (process.env[name] || '').split(/[,\s]+/).filter(Boolean);
}

function isAdmin(userId) {
  return idList('ADMIN_USER_IDS').includes(String(userId));
}

async function isAllowed(userId) {
  const admins = idList('ADMIN_USER_IDS');
  const allowed = idList('ALLOWED_USER_IDS');
  const id = String(userId);
  if (admins.includes(id) || allowed.includes(id)) return true;
  if (!admins.length && !allowed.length && !store.isConfigured()) return true; // fully open bot
  if (!store.isConfigured()) return false;
  return (await store.isMember(id)) && !(await store.isBanned(id));
}

function displayName(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return from.username ? `${name} (@${from.username})` : name || String(from.id);
}

async function handleJoin(msg, word) {
  const chatId = msg.chat.id;
  const id = String(msg.from.id);
  const password = (process.env.JOIN_PASSWORD || '').trim();
  if (!password || !store.isConfigured()) {
    await sendText(chatId, 'Регистрация по кодовому слову не настроена.');
    return;
  }
  if (await store.isBanned(id)) {
    await sendText(chatId, 'Доступ закрыт.');
    return;
  }
  if (word.trim() !== password) {
    await sendText(chatId, 'Неверное кодовое слово.');
    return;
  }
  await store.addMember(id, { name: displayName(msg.from) });
  await sendText(chatId, 'Доступ открыт. Присылай голосовые.');
}

async function handleAdmin(msg, cmd, arg) {
  const chatId = msg.chat.id;
  if (!store.isConfigured()) {
    await sendText(chatId, 'Хранилище не настроено.');
    return;
  }
  if (cmd === 'users') {
    const users = await store.listMembers();
    if (!users.length) {
      await sendText(chatId, 'Пока никто не зарегистрирован.');
      return;
    }
    const lines = users.map((u) => `${u.id} — ${u.name || ''} — ${String(u.joined || '').slice(0, 10)}`);
    await sendLong(chatId, `Пользователи (${users.length}):\n${lines.join('\n')}`);
    return;
  }
  const id = (arg || '').trim();
  if (!/^\d+$/.test(id)) {
    await sendText(chatId, `Использование: /${cmd} <id>`);
    return;
  }
  if (cmd === 'ban') {
    await store.ban(id);
    await sendText(chatId, `${id} удалён и заблокирован.`);
  } else {
    await store.unban(id);
    await sendText(chatId, `${id} разблокирован. Для доступа ему нужно снова /join.`);
  }
}

async function transcribe(buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe');
  form.append('response_format', 'text');
  if (process.env.TRANSCRIBE_LANGUAGE) form.append('language', process.env.TRANSCRIBE_LANGUAGE);
  const r = await fetch(OPENAI_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`OpenAI ${r.status}: ${body.slice(0, 300)}`);
  }
  return (await r.text()).trim();
}

// `user` is a string or an array of OpenAI content parts (text / image_url).
async function chat(system, user) {
  const r = await fetch(OPENAI_CHAT_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.TRANSLATE_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`OpenAI chat ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  return ((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim();
}

// Returns the translation, or '' if the text is already in the target language.
async function translate(text, target) {
  const out = await chat(
    `You translate transcribed speech into ${target}. Reply with the translation only, no comments. Keep the meaning and tone; fix obvious transcription slips. If the text is already entirely in ${target}, reply with exactly: ${SAME_LANGUAGE}`,
    text,
  );
  return out === SAME_LANGUAGE ? '' : out;
}

// Short, no-filler summary. Written in `lang` if given, otherwise in the language of the text.
function summarize(text, lang) {
  const language = lang ? `Write in ${lang}.` : 'Write in the same language as the text.';
  return chat(
    `Summarize this transcribed voice message. Be brief and concrete: keep only facts, requests, decisions, dates, amounts, names. Drop greetings, filler and repetition. Use short bullet points ("- ") if there are several items, otherwise one or two sentences. No preamble. ${language}`,
    text,
  );
}

// Text from an image, or '' if there is none.
async function readImage(buffer, mime) {
  const out = await chat(
    `Extract all text from the image exactly as written, in reading order, keeping line breaks. Output only the text, no comments or formatting. If the image contains no readable text, reply with exactly: ${NO_TEXT}`,
    [
      { type: 'text', text: 'Read the text in this image.' },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
    ],
  );
  return out === NO_TEXT ? '' : out;
}

function summaryEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.SUMMARY || '').trim());
}

function summaryMinChars() {
  const n = parseInt(process.env.SUMMARY_MIN_CHARS, 10);
  return Number.isFinite(n) ? n : 300;
}

function stripPrefix(text) {
  return text.replace(/^[🎤🖼🌐📝]\s*/u, '');
}

async function downloadTelegramFile(fileId) {
  const info = await tg('getFile', { file_id: fileId });
  const url = `${TG_API}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), path: info.file_path };
}

// Send the recognized text, then translation and summary if configured.
async function deliver(chatId, text, replyTo, icon) {
  const target = (process.env.TRANSLATE_TO || '').trim();
  const withSummary = summaryEnabled() && text.length > summaryMinChars();
  await sendLong(chatId, target || withSummary ? `${icon} ${text}` : text, replyTo);
  if (target) await replyWithTranslation(chatId, text, target, replyTo);
  if (withSummary) await sendLong(chatId, `📝 ${await summarize(text, target)}`, replyTo);
}

async function sendLong(chatId, text, replyTo) {
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    await sendText(chatId, parts[i], i === 0 ? replyTo : undefined);
  }
}

async function replyWithTranslation(chatId, text, target, replyTo) {
  const translated = await translate(text, target);
  if (translated) await sendLong(chatId, `🌐 ${translated}`, replyTo);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id;

  const incoming = (msg.text || '').trim();
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(incoming);
  const command = cmd ? cmd[1].toLowerCase() : '';
  const arg = cmd ? cmd[2] || '' : '';

  if (command === 'start' || command === 'help') {
    await registerCommands();
    const extra = isAdmin(userId) ? ADMIN_HELP : '';
    await sendText(chatId, `${HELP}${extra}\n\nТвой Telegram id: ${userId}`);
    return;
  }
  if (command === 'join') {
    await handleJoin(msg, arg);
    return;
  }
  if (['users', 'ban', 'unban'].includes(command)) {
    if (!isAdmin(userId)) {
      await sendText(chatId, 'Только для админа.');
      return;
    }
    await handleAdmin(msg, command, arg);
    return;
  }
  if (!(await isAllowed(userId))) {
    await sendText(chatId, `Нет доступа. Если у тебя есть кодовое слово: /join слово\nТвой id: ${userId}`);
    return;
  }

  // "/tr en" as a reply to a message: translate that message's text once.
  const tr = msg.text && /^\/tr(?:@\w+)?\s+(.+)$/i.exec(msg.text.trim());
  if (tr) {
    const source = msg.reply_to_message && msg.reply_to_message.text;
    if (!source) {
      await sendText(chatId, 'Ответь командой /tr <язык> на сообщение с текстом.');
      return;
    }
    const translated = await translate(stripPrefix(source), tr[1]);
    await sendLong(chatId, translated || 'Текст уже на этом языке.', msg.message_id);
    return;
  }

  // "/sum" as a reply to a message: summarize that message's text once.
  if (msg.text && /^\/sum(?:@\w+)?\s*$/i.test(msg.text.trim())) {
    const source = msg.reply_to_message && msg.reply_to_message.text;
    if (!source) {
      await sendText(chatId, 'Ответь командой /sum на сообщение с текстом.');
      return;
    }
    const summary = await summarize(stripPrefix(source), (process.env.TRANSLATE_TO || '').trim());
    await sendLong(chatId, `📝 ${summary}`, msg.message_id);
    return;
  }

  const image = pickImage(msg);
  if (image) {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const { buffer } = await downloadTelegramFile(image.fileId);
    const text = await readImage(buffer, image.mime);
    if (!text) {
      await sendText(chatId, 'Текста на картинке не нашёл.', msg.message_id);
      return;
    }
    await deliver(chatId, text, msg.message_id, '🖼');
    return;
  }

  const file = pickFile(msg);
  if (!file) {
    if (msg.text) await sendText(chatId, 'Пришли голосовое, аудиофайл или картинку с текстом.');
    return;
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const { buffer, path } = await downloadTelegramFile(file.fileId);
  const text = await transcribe(buffer, uploadName(file.name, path));
  if (!text) {
    await sendText(chatId, 'Не удалось распознать речь.', msg.message_id);
    return;
  }
  await deliver(chatId, text, msg.message_id, '🎤');
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('bad secret');
  }

  const update = req.body || {};
  const msg = update.message;
  if (msg) {
    try {
      await handleMessage(msg);
    } catch (e) {
      console.error('handleMessage failed', e);
      await sendText(msg.chat.id, `Ошибка: ${e.message}`, msg.message_id).catch(() => {});
    }
  }
  // Always 200 so Telegram doesn't retry the same update.
  return res.status(200).send('ok');
}

module.exports = handler;
module.exports.pickFile = pickFile;
module.exports.pickImage = pickImage;
module.exports.uploadName = uploadName;
module.exports.chunk = chunk;
module.exports.isAllowed = isAllowed;
module.exports.isAdmin = isAdmin;
