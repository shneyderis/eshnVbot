// Telegram webhook: receives a voice/audio message (e.g. forwarded from WhatsApp),
// transcribes it with OpenAI and replies with the text.
//
// Env vars (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN       token from @BotFather (required)
//   OPENAI_API_KEY           OpenAI API key (required)
//   TELEGRAM_WEBHOOK_SECRET  any random string; must match the one passed to setWebhook (recommended)
//   ALLOWED_USER_IDS         comma-separated Telegram user ids allowed to use the bot (recommended)
//   TRANSCRIBE_MODEL         default "gpt-4o-transcribe" (alternative: "whisper-1")
//   TRANSCRIBE_LANGUAGE      optional ISO-639-1 hint ("ru", "uk", "en"); default: auto-detect

const TG_API = 'https://api.telegram.org';
const OPENAI_API = 'https://api.openai.com/v1/audio/transcriptions';
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

function isAllowed(userId) {
  const raw = (process.env.ALLOWED_USER_IDS || '').trim();
  if (!raw) return true;
  return raw.split(/[,\s]+/).filter(Boolean).includes(String(userId));
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

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id;

  if (msg.text && msg.text.startsWith('/start')) {
    await sendText(chatId, `Привет. Перешли сюда голосовое (из WhatsApp: зажать → Переслать → Поделиться → Telegram), я верну текст.\n\nТвой Telegram id: ${userId}`);
    return;
  }
  if (!isAllowed(userId)) {
    await sendText(chatId, `Доступ закрыт. Твой id: ${userId}`);
    return;
  }

  const file = pickFile(msg);
  if (!file) {
    if (msg.text) await sendText(chatId, 'Пришли голосовое или аудиофайл.');
    return;
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const info = await tg('getFile', { file_id: file.fileId });
  const url = `${TG_API}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());

  const text = await transcribe(buffer, uploadName(file.name, info.file_path));
  if (!text) {
    await sendText(chatId, 'Не удалось распознать речь.', msg.message_id);
    return;
  }
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    await sendText(chatId, parts[i], i === 0 ? msg.message_id : undefined);
  }
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
module.exports.uploadName = uploadName;
module.exports.chunk = chunk;
module.exports.isAllowed = isAllowed;
