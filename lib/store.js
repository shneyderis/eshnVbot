// Minimal Upstash Redis REST client (no dependencies).
// Works with the env vars set by Vercel Marketplace (KV_REST_API_URL / KV_REST_API_TOKEN)
// or by Upstash directly (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).

const USERS = 'users';   // hash: user id -> JSON {name, username, joined}
const BANNED = 'banned'; // set of user ids

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function isConfigured() {
  return Boolean(config());
}

async function redis(...command) {
  const cfg = config();
  if (!cfg) throw new Error('Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command.map(String)),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Redis ${command[0]}: ${data.error || r.status}`);
  return data.result;
}

async function isMember(userId) {
  return (await redis('HEXISTS', USERS, userId)) === 1;
}

async function isBanned(userId) {
  return (await redis('SISMEMBER', BANNED, userId)) === 1;
}

function addMember(userId, info) {
  return redis('HSET', USERS, userId, JSON.stringify({ ...info, joined: new Date().toISOString() }));
}

async function listMembers() {
  const flat = (await redis('HGETALL', USERS)) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    let info = {};
    try { info = JSON.parse(flat[i + 1]); } catch (_) { /* ignore */ }
    out.push({ id: flat[i], ...info });
  }
  return out.sort((a, b) => String(a.joined).localeCompare(String(b.joined)));
}

async function ban(userId) {
  await redis('HDEL', USERS, userId);
  await redis('SADD', BANNED, userId);
}

function unban(userId) {
  return redis('SREM', BANNED, userId);
}

module.exports = { isConfigured, isMember, isBanned, addMember, listMembers, ban, unban, redis };
