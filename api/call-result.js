// ElevenLabs post-call webhook: a call started with /call has ended (or never connected).
// Sends the outcome and the transcript to the Telegram chat that asked for the call.
//
// Set it up in ElevenLabs: Agents -> Settings -> Post-call webhook,
// URL https://<project>.vercel.app/api/call-result, events "transcript" and "call initiation failure".
// Put the webhook secret into ELEVENLABS_WEBHOOK_SECRET.

const bot = require('./telegram');
const calls = require('../lib/calls');

// The signature covers the exact bytes ElevenLabs sent, so the parsed req.body is not enough.
// Vercel has already consumed the stream to fill req.body, but replays it to 'data'/'end' listeners.
function readRawBody(req) {
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) return Promise.resolve(String(req.rawBody));
  if (typeof req.on !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null), 5000);
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function duration(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Where to send the result: the chat that travelled with the call, else the first admin.
// A failure event carries no such variables, so it always goes to the first admin.
function destination(data) {
  const context = calls.callContext(data);
  if (context) return context;
  const chatId = bot.idList('ADMIN_USER_IDS')[0];
  return chatId ? { chatId } : null;
}

async function onTranscript(data) {
  const to = destination(data);
  if (!to) return;
  const head = `📞 Звонок${to.number ? ` на ${to.number}` : ''} завершён, ${duration((data.metadata || {}).call_duration_secs)}.`;
  const text = calls.formatTranscript(data.transcript);
  if (!calls.heardAnyone(data.transcript)) {
    await bot.sendText(to.chatId, `${head}\nСобеседника не было слышно: возможно, автоответчик, меню или трубку сразу положили.`, to.replyTo);
    if (text) await bot.sendLong(to.chatId, `🎤 ${text}`, to.replyTo);
    return;
  }
  const summary = await calls.report(bot.chat, to.task, text);
  await bot.sendLong(to.chatId, `${head}\n\n${summary}`, to.replyTo);
  // Same "🎤" prefix as transcribed voice notes, so /tr and /sum work on it as a reply.
  await bot.sendLong(to.chatId, `🎤 ${text}`, to.replyTo);
}

async function onFailure(data) {
  const to = destination(data);
  if (!to) return;
  const number = to.number || ((data.metadata || {}).body || {}).to_number || '';
  await bot.sendText(to.chatId, `📞 Не дозвонился${number ? ` на ${number}` : ''}: ${calls.failureText(data)}.`, to.replyTo);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  const secret = (process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('call-result: ELEVENLABS_WEBHOOK_SECRET is not set');
    return res.status(503).send('not configured');
  }
  const raw = await readRawBody(req);
  if (!calls.verifySignature(raw, req.headers['elevenlabs-signature'], secret)) {
    return res.status(401).send('bad signature');
  }

  let event;
  try { event = JSON.parse(raw); } catch (_) { return res.status(400).send('bad json'); }
  const data = event.data || {};
  const handle = { post_call_transcription: onTranscript, call_initiation_failure: onFailure }[event.type];
  if (!handle || !data.conversation_id) return res.status(200).send('ignored');

  // ElevenLabs retries a delivery that was not answered with 200: report each call once.
  const key = `${event.type}:${data.conversation_id}`;
  if (!(await calls.claimEvent(key))) return res.status(200).send('duplicate');
  try {
    await handle(data);
  } catch (e) {
    console.error('call-result failed', e);
    await calls.releaseEvent(key);
    return res.status(500).send('error'); // 5xx makes ElevenLabs retry
  }
  return res.status(200).send('ok');
}

module.exports = handler;
module.exports.readRawBody = readRawBody;
