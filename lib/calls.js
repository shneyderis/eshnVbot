// Outbound phone calls made by an ElevenLabs voice agent over your own SIP trunk.
//
// Flow: "/call <brief>" in Telegram -> planCall() turns the brief into a call plan ->
// the admin confirms with a button -> startCall() asks ElevenLabs to dial ->
// ElevenLabs posts the transcript to api/call-result.js when the call ends.
//
// Calls need no storage. The plan lives in the confirmation message itself (planSummary /
// parsePlan), and the chat a call belongs to travels with the call as dynamic variables.
// Redis, when it is configured and reachable, only adds remembered numbers and
// protection against a duplicated result webhook.
//
// Env vars:
//   ELEVENLABS_API_KEY          API key (required)
//   ELEVENLABS_AGENT_ID         agent that makes the calls (required)
//   ELEVENLABS_PHONE_NUMBER_ID  id of the phone number imported into ElevenLabs (required)
//   ELEVENLABS_TELEPHONY        "sip" (default) or "twilio": where that number was imported from
//   ELEVENLABS_WEBHOOK_SECRET   secret of the post-call webhook (required for results)
//   CALL_ON_BEHALF_OF           name the agent calls on behalf of, e.g. "Eugene" (recommended)
//   CALL_CALLBACK_NUMBER        number the agent may give out for a call back (optional)
//   CALL_TIMEZONE               time zone for "today / tomorrow" in briefs, default Europe/Madrid
//   CALL_PLAN_MODEL             OpenAI model that plans the call, default TRANSLATE_MODEL / gpt-4o-mini
//   CALL_SEARCH_MODEL           OpenAI model that looks up phone numbers on the web, default CALL_PLAN_MODEL
//
// "/call позвони в ресторан X" works without a number: the number is taken from the saved contacts
// (Redis hash "contacts") or found on the web, shown in the plan, and saved once the call is confirmed.

const crypto = require('node:crypto');
const store = require('./store');

const ELEVENLABS_CALL_API = {
  sip: 'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call',
  twilio: 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call',
};
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const CONTACTS = 'contacts'; // hash: normalized name -> JSON {name, number, address, source, saved}
const CALL_TTL_SECS = 2 * 24 * 60 * 60; // how long we remember which chat a call belongs to
const SIGNATURE_TOLERANCE_SECS = 30 * 60;

const REQUIRED_ENV = ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_PHONE_NUMBER_ID'];

function missingConfig() {
  return REQUIRED_ENV.filter((name) => !(process.env[name] || '').trim());
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

function callApi() {
  const kind = (process.env.ELEVENLABS_TELEPHONY || 'sip').trim().toLowerCase();
  return ELEVENLABS_CALL_API[kind] || ELEVENLABS_CALL_API.sip;
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
  '"place_name": "<proper name of the business or person being called, as it is usually written, without generic words like restaurant or clinic; empty string if the brief gives no name>",',
  '"place_location": "<city, country or address from the brief that helps to find that place; empty string if none>",',
  '"first_message": "<opening line in the call language: a greeting, a statement that this is an AI assistant calling on behalf of the person, and the purpose in one short sentence>",',
  '"task": "<instructions for the agent, in Russian, plain text without blank lines: the goal, every relevant fact from the brief (names, dates, times, party size, preferences, acceptable alternatives), what counts as success, and what to find out and bring back (confirmation number, price, address, opening hours...)>",',
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
  const oneLine = (v) => str(v).replace(/\s+/g, ' ');
  return {
    number: leadingNumber(brief) || normalizeNumber(data.to_number),
    numberSource: 'brief',
    language: str(data.language).toLowerCase().slice(0, 5),
    languageRu: oneLine(data.language_name_ru),
    languageEn: oneLine(data.language_name_en),
    callee: oneLine(data.callee_ru),
    placeName: oneLine(data.place_name),
    placeLocation: oneLine(data.place_location),
    firstMessage: oneLine(data.first_message),
    task: str(data.task).replace(/\n{2,}/g, '\n'),
    missing: Array.isArray(data.missing_ru) ? data.missing_ru.map(str).filter(Boolean).slice(0, 4) : [],
  };
}

// System prompt for the voice agent. The rules are fixed here, not written by the planner model.
function agentPrompt(plan) {
  const who = principal() || 'the person you represent';
  const callback = (process.env.CALL_CALLBACK_NUMBER || '').trim();
  const language = plan.languageEn
    || (plan.language ? `the language with ISO 639-1 code "${plan.language}"${plan.languageRu ? ` (${plan.languageRu})` : ''}` : '')
    || 'the language of the person who answers';
  return [
    `You are an AI voice assistant making a phone call on behalf of ${who}. You are the caller.`,
    `Speak ${language}. If the other person switches language, follow them.`,
    `Today is ${today()}.`,
    '',
    '# Task',
    'The task is written in Russian for you only; that is not the language of the call.',
    plan.task,
    '',
    '# Opening',
    'The other person speaks first when they pick up. Then open with this line (adapt it if they already said who they are):',
    plan.firstMessage || `A greeting, that you are an AI assistant calling on behalf of ${who}, and why you are calling.`,
    '',
    '# Rules',
    `- Your opening must say that you are an AI assistant calling on behalf of ${who}. If asked whether you are a robot or an AI, say yes.`,
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

// Where the number came from, so a wrong one is caught before dialing.
function numberNote(plan) {
  if (plan.numberSource === 'contacts') return ` (из базы: ${plan.placeName})`;
  if (plan.numberSource !== 'web') return '';
  const where = [plan.foundName, plan.foundAddress].filter(Boolean).join(', ');
  return `\n⚠️ Номер найден в интернете, проверь${where ? `: ${where}` : ''}${plan.sourceUrl ? `\nИсточник: ${plan.sourceUrl}` : ''}`;
}

const TASK_HEADER = 'Задание агенту:';
const MISSING_HEADER = 'В задании нет (если спросят, бот ответит, что уточнит):';

// Text of the confirmation message shown before dialing. It is also where the plan is kept
// until the button is pressed: parsePlan() reads it back, so keep the two in step.
function planSummary(plan) {
  const lines = [
    '📞 Позвонить?',
    `Номер: ${plan.number}${numberNote(plan)}`,
    plan.callee ? `Кому: ${plan.callee}` : '',
    plan.placeName && plan.numberSource !== 'contacts' ? `Место: ${plan.placeName}` : '',
    `Язык: ${plan.languageRu || 'не определён'}${plan.language ? ` (${plan.language})` : ''}`,
    plan.firstMessage ? `Первая фраза: «${plan.firstMessage}»` : '',
  ].filter(Boolean);
  lines.push('', TASK_HEADER, plan.task);
  if (plan.missing && plan.missing.length) {
    lines.push('', MISSING_HEADER, ...plan.missing.map((m) => `• ${m}`));
  }
  return lines.join('\n');
}

// Reads a plan back from the text of a confirmation message. Returns null if it is not one.
function parsePlan(text) {
  const t = String(text || '');
  const line = (re) => { const m = re.exec(t); return m ? m[1].trim() : ''; };
  const number = normalizeNumber(line(/^Номер: (\+\d{7,15})/m));
  const from = t.indexOf(`\n${TASK_HEADER}\n`);
  if (!number || from < 0) return null;
  const rest = t.slice(from + TASK_HEADER.length + 2);
  const until = rest.indexOf('\n\n');
  const task = (until < 0 ? rest : rest.slice(0, until)).trim();
  if (!task) return null;
  const lang = /^Язык: (.*?)(?: \(([a-z-]{2,5})\))?$/m.exec(t) || [];
  const found = line(/^⚠️ Номер найден в интернете, проверь: (.+)$/m);
  const fromContacts = line(/^Номер: \+\d+ \(из базы: (.+)\)$/m);
  return {
    number,
    numberSource: fromContacts ? 'contacts' : /^⚠️ Номер найден в интернете/m.test(t) ? 'web' : 'brief',
    language: lang[2] || '',
    languageRu: lang[1] && lang[1] !== 'не определён' ? lang[1] : '',
    callee: line(/^Кому: (.+)$/m),
    placeName: fromContacts || line(/^Место: (.+)$/m),
    foundAddress: found.includes(', ') ? found.slice(found.indexOf(', ') + 2) : '',
    sourceUrl: line(/^Источник: (https?:\/\/\S+)$/m),
    firstMessage: line(/^Первая фраза: «(.*)»$/m),
    task,
    missing: [],
  };
}

function contactKey(name) {
  return String(name || '').toLowerCase().replace(/[\s"'«»“”.,]+/g, ' ').trim();
}

async function listContacts() {
  const flat = (await store.redis('HGETALL', CONTACTS)) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push({ key: flat[i], ...JSON.parse(flat[i + 1]) }); } catch (_) { /* ignore */ }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Exact name first, then a saved name that contains the asked one or the other way round.
async function findContact(name) {
  const key = contactKey(name);
  if (!key) return null;
  const all = await listContacts();
  return all.find((c) => c.key === key)
    || all.find((c) => key.length >= 4 && (c.key.includes(key) || key.includes(c.key)))
    || null;
}

function saveContact(contact) {
  const key = contactKey(contact.name);
  if (!key || !normalizeNumber(contact.number)) return Promise.resolve();
  return store.redis('HSET', CONTACTS, key, JSON.stringify({
    name: contact.name, number: contact.number, address: contact.address || '',
    source: contact.source || '', saved: new Date().toISOString(),
  }));
}

// Returns the removed contact or null.
async function forgetContact(name) {
  const found = await findContact(name);
  if (!found) return null;
  await store.redis('HDEL', CONTACTS, found.key);
  return found;
}

const LOOKUP_PROMPT = [
  'Find the phone number of the place described by the user. Search the web.',
  'Prefer the official website of the place, then well-known maps and directory listings.',
  'Reply with a JSON object only, no other text:',
  '{"name": "<name of the place you found>", "phone": "<its phone number in international format starting with +, digits only after the plus>", "address": "<its address, short>", "source_url": "<page where the number is published>"}',
  'If you cannot find a number you are confident belongs to exactly this place, reply with "phone": "".',
].join('\n');

// Looks a phone number up on the web with OpenAI's web search tool. Returns null if nothing reliable is found.
async function lookupNumber(name, location, brief) {
  const model = process.env.CALL_SEARCH_MODEL || process.env.CALL_PLAN_MODEL || process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
  const r = await fetch(OPENAI_RESPONSES_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      tools: [{ type: 'web_search' }],
      instructions: LOOKUP_PROMPT,
      input: `Place: ${name}\nLocation: ${location || 'not given'}\nContext from the request: ${String(brief).slice(0, 500)}`,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`поиск номера не сработал (OpenAI ${r.status}: ${body.slice(0, 200)})`);
  }
  const data = await r.json();
  const text = (data.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('\n');
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) return null;
  let found;
  try { found = JSON.parse(json[0]); } catch (_) { return null; }
  const number = normalizeNumber(found.phone);
  if (!number) return null;
  const url = /^https?:\/\/\S+$/.test(String(found.source_url || '')) ? String(found.source_url) : '';
  return { number, name: String(found.name || name).trim(), address: String(found.address || '').trim(), sourceUrl: url };
}

// Fills plan.number when the brief named a place instead of a number: saved contacts first, then the web.
async function resolveNumber(plan, brief) {
  if (plan.number || !plan.placeName) return plan;
  // A store that is down or archived must not stop the call: fall through to the web search.
  const contact = store.isConfigured() ? await findContact(plan.placeName).catch(() => null) : null;
  if (contact) return { ...plan, number: contact.number, numberSource: 'contacts', placeName: contact.name };
  const found = await lookupNumber(plan.placeName, plan.placeLocation, brief);
  if (!found) return plan;
  return {
    ...plan, number: found.number, numberSource: 'web',
    foundName: found.name, foundAddress: found.address, sourceUrl: found.sourceUrl,
  };
}

// Called once the admin confirms the call: remember the number under the place's name.
function rememberPlace(plan) {
  if (!store.isConfigured() || !plan.placeName || !plan.number || plan.numberSource === 'contacts') return Promise.resolve();
  return saveContact({ name: plan.placeName, number: plan.number, address: plan.foundAddress, source: plan.sourceUrl })
    .catch(() => {});
}

// Asks ElevenLabs to dial. Returns the conversation id used to match the result webhook.
async function startCall(plan, context) {
  // The opening line lives in the prompt: the "first message" override is not available on every
  // ElevenLabs plan, and on an outbound call the person who picks up speaks first anyway.
  const agent = { prompt: { prompt: agentPrompt(plan) } };
  if (plan.language) agent.language = plan.language;
  const r = await fetch(callApi(), {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: plan.number,
      conversation_initiation_client_data: {
        conversation_config_override: { agent },
        // Echoed back in the result webhook: this is how the result finds its chat.
        dynamic_variables: {
          tg_chat_id: String(context.chatId),
          tg_reply_to: String(context.replyTo || ''),
          call_number: plan.number,
          call_task: plan.task.slice(0, 800),
        },
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
  return data.conversation_id || '';
}

// Which chat a finished call belongs to, from the variables sent with it in startCall().
function callContext(data) {
  const vars = ((data && data.conversation_initiation_client_data) || {}).dynamic_variables || {};
  if (!vars.tg_chat_id) return null;
  return {
    chatId: vars.tg_chat_id,
    replyTo: Number(vars.tg_reply_to) || undefined,
    number: vars.call_number || '',
    task: vars.call_task || '',
  };
}

// True the first time an event is seen. ElevenLabs retries a webhook that was not answered with 200.
// Without a working store every event counts as new: a rare duplicate report beats a lost one.
async function claimEvent(key) {
  if (!store.isConfigured()) return true;
  try {
    return (await store.redis('SET', `calldone:${key}`, '1', 'NX', 'EX', CALL_TTL_SECS)) !== null;
  } catch (_) {
    return true;
  }
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

function report(chat, task, transcriptText) {
  const extra = process.env.CALL_PLAN_MODEL ? { model: process.env.CALL_PLAN_MODEL } : {};
  return chat(REPORT_PROMPT, `Цель звонка: ${task || 'не указана'}\n\nРасшифровка:\n${transcriptText}`, extra);
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
  missingConfig, normalizeNumber, leadingNumber, planCall, agentPrompt, planSummary, parsePlan,
  resolveNumber, rememberPlace, listContacts, findContact, saveContact, forgetContact, lookupNumber,
  startCall, callContext, claimEvent, releaseEvent,
  verifySignature, sign, formatTranscript, heardAnyone, report, failureText,
};
