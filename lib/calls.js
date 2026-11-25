// Outbound phone calls made by an ElevenLabs voice agent over your own SIP trunk.
//
// Flow: "/call <brief>" in Telegram -> planCall() turns the brief into a call plan ->
// the admin confirms with a button -> startCall() asks ElevenLabs to dial ->
// ElevenLabs posts the transcript to api/call-result.js when the call ends.
//
// Env vars:
//   ELEVENLABS_API_KEY          API key (required)
//   ELEVENLABS_AGENT_ID         agent that makes the calls (required)
//   ELEVENLABS_PHONE_NUMBER_ID  id of the SIP trunk number imported into ElevenLabs (required)
//   ELEVENLABS_WEBHOOK_SECRET   secret of the post-call webhook (required for results)
//   CALL_ON_BEHALF_OF           name the agent calls on behalf of, e.g. "Eugene" (recommended)
//   CALL_CALLBACK_NUMBER        number the agent may give out for a call back (optional)
//   CALL_TIMEZONE               time zone for "today / tomorrow" in briefs, default Europe/Madrid
//   CALL_PLAN_MODEL             OpenAI model that plans the call, default TRANSLATE_MODEL / gpt-4o-mini

const crypto = require('node:crypto');
const store = require('./store');

const ELEVENLABS_CALL_API = 'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call';
const PLAN_TTL_SECS = 15 * 60;          // how long a plan waits for the confirm button
const CALL_TTL_SECS = 2 * 24 * 60 * 60; // how long we remember which chat a call belongs to
const SIGNATURE_TOLERANCE_SECS = 30 * 60;

const REQUIRED_ENV = ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_PHONE_NUMBER_ID'];

function missingConfig() {
  const missing = REQUIRED_ENV.filter((name) => !(process.env[name] || '').trim());
  if (!store.isConfigured()) missing.push('Redis (KV_REST_API_URL / KV_REST_API_TOKEN)');
  return missing;
}

// "+81 (3) 1234-5678" / "0081 3 1234 5678" -> "+81312345678". Returns '' unless the result is E.164.
function normalizeNumber(input) {
  let s = String(input || '').trim().replace(/[\s().\-‐-―]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : '';
}

// A number typed right after the command wins over whatever the model reads from the brief.
function leadingNumber(text) {
  const m = /^\s*((?:\+|00)[\d\s().\-]{6,24}\d)(?=\s|$)/.exec(String(text || ''));
  return m ? normalizeNumber(m[1]) : '';
}

function today() {
  const timeZone = process.env.CALL_TIMEZONE || 'Europe/Madrid';
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now); // YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  return `${date} (${weekday}), time zone ${timeZone}`;
}

function principal() {
  return (process.env.CALL_ON_BEHALF_OF || '').trim();
}

const PLAN_PROMPT = [
  'You prepare a phone call that an AI voice agent will make on behalf of a person.',
  'The user message is that person\'s brief, in any language; it may be a transcribed voice note.',
  'Respond with a JSON object:',
  '{',
  '"to_number": "<phone number to call from the brief, international format starting with +; empty string if the brief has none>",',
  '"language": "<ISO 639-1 code of the language to speak on the call: the one the brief asks for, otherwise the main language of the country being called>",',
  '"language_name_ru": "<that language, in Russian>",',
  '"language_name_en": "<that language, in English>",',
  '"callee_ru": "<who is being called, in Russian, a few words>",',
  '"goal_ru": "<one or two sentences in Russian: what the agent will try to achieve, with the key details (dates, times, names, numbers)>",',
  '"first_message": "<opening line in the call language: a greeting, a statement that this is an AI assistant calling on behalf of the person, and the purpose in one short sentence>",',
  '"task": "<instructions for the agent, in English: the goal, every relevant fact from the brief (names, dates, times, party size, preferences, acceptable alternatives), what counts as success, and what to find out and bring back (confirmation number, price, address, opening hours...)>",',
  '"missing_ru": ["<up to 4 details the other side will probably ask for that the brief does not give, in Russian>"]',
  '}',
  'Use only facts from the brief. Never invent names, dates, document numbers or preferences.',
  'Resolve relative dates ("tomorrow", "next Friday") to calendar dates.',
].join('\n');

// `chat(system, user, extra)` is the OpenAI helper from api/telegram.js.
async function planCall(chat, brief) {
  const name = principal();
  const system = [
    PLAN_PROMPT,
    `Today is ${today()}.`,
    name ? `The person is ${name}.` : 'The person\'s name is not known unless the brief gives it.',
  ].join('\n');
  const extra = { response_format: { type: 'json_object' } };
  if (process.env.CALL_PLAN_MODEL) extra.model = process.env.CALL_PLAN_MODEL;
  const out = await chat(system, brief, extra);
  let data;
  try { data = JSON.parse(out); } catch (_) { throw new Error('не смог разобрать задание'); }
  const str = (v) => String(v || '').trim();
  return {
    number: leadingNumber(brief) || normalizeNumber(data.to_number),
    language: str(data.language).toLowerCase().slice(0, 5),
    languageRu: str(data.language_name_ru),
    languageEn: str(data.language_name_en),
    callee: str(data.callee_ru),
    goal: str(data.goal_ru),
    firstMessage: str(data.first_message),
    task: str(data.task),
    missing: Array.isArray(data.missing_ru) ? data.missing_ru.map(str).filter(Boolean).slice(0, 4) : [],
  };
}

// System prompt for the voice agent. The rules are fixed here, not written by the planner model.
function agentPrompt(plan) {
  const who = principal() || 'the person you represent';
  const callback = (process.env.CALL_CALLBACK_NUMBER || '').trim();
  return [
    `You are an AI voice assistant making a phone call on behalf of ${who}. You are the caller.`,
    `Speak ${plan.languageEn || 'the language of the person who answers'}. If the other person switches language, follow them.`,
    `Today is ${today()}.`,
    '',
    '# Task',
    plan.task,
    '',
    '# Rules',
    `- Say at the start that you are an AI assistant calling on behalf of ${who}. If asked whether you are a robot or an AI, say yes.`,
    `- Use only the facts in the task. If you are asked for anything that is not there (a document number, a date of birth, a choice that was not listed), say you will check with ${who} and that they will get back. Never guess and never invent.`,
    '- Never give or take payment card details. Do not agree to a payment, a deposit or anything that costs money unless the task explicitly allows it.',
    '- Be brief and polite. Ask one question at a time and let the other person finish.',
    '- Before you finish, repeat the agreed details (date, time, name, number of people, reference number) and ask the other person to confirm them.',
    '- If you reach voicemail, an answering machine or a phone menu you cannot get through, hang up without leaving a message.',
    '- If the person says it is a wrong number or asks not to be called, apologise and end the call.',
    '- When the goal is reached, or it is clear that it cannot be reached, say goodbye and end the call.',
    callback
      ? `- If asked for a number to call back, give ${callback}.`
      : `- If asked for a number to call back, say ${who} will call back themselves.`,
  ].join('\n');
}

// Text of the confirmation message shown before dialing.
function planSummary(plan) {
  const lines = [
    '📞 Позвонить?',
    `Номер: ${plan.number}`,
    plan.callee ? `Кому: ${plan.callee}` : '',
    `Язык: ${plan.languageRu || plan.language || 'не определён'}`,
    `Задача: ${plan.goal}`,
    plan.firstMessage ? `Первая фраза: «${plan.firstMessage}»` : '',
  ].filter(Boolean);
  if (plan.missing.length) {
    lines.push('', 'В задании нет (если спросят, бот ответит, что уточнит):', ...plan.missing.map((m) => `• ${m}`));
  }
  return lines.join('\n');
}

async function savePlan(plan, context) {
  const id = crypto.randomBytes(8).toString('hex');
  await store.redis('SET', `callplan:${id}`, JSON.stringify({ plan, ...context }), 'EX', PLAN_TTL_SECS);
  return id;
}

// Returns the saved plan and removes it, so a second tap on the button cannot dial twice.
async function takePlan(id) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return null;
  const raw = await store.redis('GETDEL', `callplan:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Asks ElevenLabs to dial. Returns the conversation id used to match the result webhook.
async function startCall(plan, context) {
  const agent = { prompt: { prompt: agentPrompt(plan) } };
  if (plan.firstMessage) agent.first_message = plan.firstMessage;
  if (plan.language) agent.language = plan.language;
  const r = await fetch(ELEVENLABS_CALL_API, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: plan.number,
      conversation_initiation_client_data: {
        conversation_config_override: { agent },
        // Echoed back in the result webhook: a fallback if the Redis record is gone.
        dynamic_variables: { tg_chat_id: String(context.chatId) },
      },
    }),
  });
  const text = await r.text().catch(() => '');
  let data = {};
  try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!r.ok || data.success === false) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || '');
    throw new Error(`ElevenLabs ${r.status}: ${(data.message || detail || text).slice(0, 300)}`);
  }
  const conversationId = data.conversation_id || '';
  if (conversationId) {
    await store.redis('SET', `call:${conversationId}`,
      JSON.stringify({ ...context, number: plan.number, goal: plan.goal }), 'EX', CALL_TTL_SECS);
  }
  return conversationId;
}

async function findCall(conversationId) {
  if (!conversationId || !store.isConfigured()) return null;
  const raw = await store.redis('GET', `call:${conversationId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// True the first time an event is seen. ElevenLabs retries a webhook that was not answered with 200.
async function claimEvent(key) {
  if (!store.isConfigured()) return true;
  return (await store.redis('SET', `calldone:${key}`, '1', 'NX', 'EX', CALL_TTL_SECS)) !== null;
}

function releaseEvent(key) {
  if (!store.isConfigured()) return Promise.resolve();
  return store.redis('DEL', `calldone:${key}`).catch(() => {});
}

// ElevenLabs-Signature: "t=<unix seconds>,v0=<hex hmac-sha256 of '<t>.<raw body>'>".
function verifySignature(rawBody, header, secret, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!secret || !header || rawBody == null) return false;
  const parts = String(header).split(',').map((p) => p.trim());
  const t = (parts.find((p) => p.startsWith('t=')) || '').slice(2);
  const sig = (parts.find((p) => p.startsWith('v0=')) || '').slice(3);
  if (!/^\d+$/.test(t) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (Math.abs(nowSecs - Number(t)) > SIGNATURE_TOLERANCE_SECS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'));
}

function sign(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v0=${crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

// "Бот: ... / Собеседник: ..." lines from the webhook transcript.
function formatTranscript(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .filter((turn) => turn && typeof turn.message === 'string' && turn.message.trim())
    .map((turn) => `${turn.role === 'agent' ? 'Бот' : 'Собеседник'}: ${turn.message.trim()}`)
    .join('\n');
}

function heardAnyone(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .some((turn) => turn && turn.role !== 'agent' && typeof turn.message === 'string' && turn.message.trim());
}

const REPORT_PROMPT = [
  'Report on a phone call that an AI assistant made on behalf of a person. Write in Russian, for that person.',
  'You get the goal of the call and the transcript ("Бот" is the assistant, "Собеседник" is the other side).',
  'First line: "Итог: " and whether the goal was reached, reached partly or not reached.',
  'Then short bullet points ("- ") with what was agreed or found out: dates, times, names, prices, reference numbers, addresses.',
  'If the other side asked for something, or something is left for the person to do, add a last line starting with "Нужно от вас: ".',
  'Use only what is in the transcript. If something was not said, do not state it. No preamble.',
].join('\n');

function report(chat, goal, transcriptText) {
  const extra = process.env.CALL_PLAN_MODEL ? { model: process.env.CALL_PLAN_MODEL } : {};
  return chat(REPORT_PROMPT, `Цель звонка: ${goal || 'не указана'}\n\nРасшифровка:\n${transcriptText}`, extra);
}

const FAILURE_RU = { busy: 'занято', 'no-answer': 'не ответили', unknown: 'звонок не прошёл' };

// Human-readable line for a call_initiation_failure event.
function failureText(data) {
  const reason = FAILURE_RU[data && data.failure_reason] || 'звонок не прошёл';
  const body = (data && data.metadata && data.metadata.body) || {};
  const sip = body.sip_status_code ? ` (SIP ${body.sip_status_code}${body.sip_status ? ` ${body.sip_status}` : ''})` : '';
  return `${reason}${sip}`;
}

module.exports = {
  missingConfig, normalizeNumber, leadingNumber, planCall, agentPrompt, planSummary,
  savePlan, takePlan, startCall, findCall, claimEvent, releaseEvent,
  verifySignature, sign, formatTranscript, heardAnyone, report, failureText,
};
