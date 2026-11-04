// A/B Barbell server: passkey sign-in, cloud copy of the workout log, and push
// notifications (training-day reminders and rest-timer alerts).
// Static app files in ./app are served by Cloudflare; only /api/* reaches this code.

import { DurableObject } from 'cloudflare:workers';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { generateVapidKeys, sendPush, b64u, unb64u } from './webpush.js';
import { nextReminder } from './schedule.js';

const PUSH_SUBJECT = 'https://github.com/ant-man21/ab-barbell';
const te = new TextEncoder();

/* ---------------- small helpers ---------------- */
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const fail = (status, error) => json({ error }, status);
const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(str) { return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(str)))); }

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', unb64u(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signTicket(secret, data) {
  const body = b64u(te.encode(JSON.stringify(data)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(body)));
  return body + '.' + b64u(sig);
}
async function readTicket(secret, ticket) {
  const [body, sig] = String(ticket || '').split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(sig), te.encode(body));
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(unb64u(body)));
  return data.exp > Date.now() ? data : null;
}
// Recovery codes look like ABCD-EFGH-JKLM-NPQR (no 0/O/1/I).
function makeRecoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [0, 4, 8, 12].map(i => Array.from(b.slice(i, i + 4), x => A[x % A.length]).join('')).join('-');
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------------- Directory: accounts, passkeys, sessions, server keys ---------------- */
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, recovery TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS creds (id TEXT PRIMARY KEY, user TEXT, pubkey TEXT, counter INTEGER, transports TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user TEXT, created INTEGER, seen INTEGER);
    `);
  }
  _get(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }
  _set(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, v); }

  async keys() {
    let secret = this._get('hmac');
    if (!secret) { secret = randomToken(32); this._set('hmac', secret); }
    let vapid = this._get('vapid');
    if (!vapid) { vapid = JSON.stringify(await generateVapidKeys()); this._set('vapid', vapid); }
    return { secret, vapid: JSON.parse(vapid) };
  }
  userCount() { return this.sql.exec('SELECT COUNT(*) AS n FROM users').one().n; }
  getUser(id) { return this.sql.exec('SELECT id, name FROM users WHERE id = ?', id).toArray()[0] || null; }

  createUser(id, name, recoveryHash, cred) {
    if (this.getUser(id)) throw new Error('exists');
    this.sql.exec('INSERT INTO users (id, name, recovery, created) VALUES (?, ?, ?, ?)', id, name, recoveryHash, Date.now());
    this.addCred(id, cred);
  }
  addCred(user, cred) {
    this.sql.exec('INSERT OR REPLACE INTO creds (id, user, pubkey, counter, transports, created) VALUES (?, ?, ?, ?, ?, ?)',
      cred.id, user, cred.publicKey, cred.counter, JSON.stringify(cred.transports || []), Date.now());
  }
  getCred(id) {
    const r = this.sql.exec('SELECT * FROM creds WHERE id = ?', id).toArray()[0];
    return r ? { ...r, transports: JSON.parse(r.transports || '[]') } : null;
  }
  credIds(user) { return this.sql.exec('SELECT id, transports FROM creds WHERE user = ?', user).toArray().map(r => ({ id: r.id, transports: JSON.parse(r.transports || '[]') })); }
  bumpCounter(id, counter) { this.sql.exec('UPDATE creds SET counter = ? WHERE id = ?', counter, id); }
  userByRecovery(hash) { return this.sql.exec('SELECT id, name FROM users WHERE recovery = ?', hash).toArray()[0] || null; }
  setRecovery(user, hash) { this.sql.exec('UPDATE users SET recovery = ? WHERE id = ?', hash, user); }

  newSession(user, hash) { this.sql.exec('INSERT INTO sessions (hash, user, created, seen) VALUES (?, ?, ?, ?)', hash, user, Date.now(), Date.now()); }
  sessionUser(hash) {
    const r = this.sql.exec('SELECT user FROM sessions WHERE hash = ?', hash).toArray()[0];
    if (!r) return null;
    this.sql.exec('UPDATE sessions SET seen = ? WHERE hash = ?', Date.now(), hash);
    return this.getUser(r.user);
  }
  endSession(hash) { this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash); }
}

/* ---------------- UserStore: one per account. Log, devices, scheduled alerts ---------------- */
export class UserStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created INTEGER);
    `);
  }
  _get(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray(); return r.length ? JSON.parse(r[0].v) : null; }
  _set(k, v) { if (v == null) this.sql.exec('DELETE FROM kv WHERE k = ?', k); else this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, JSON.stringify(v)); }

  getState() { return { state: this._get('state'), updatedAt: this._get('updatedAt') || 0 }; }
  async putState(state, updatedAt, reminder) {
    const cur = this._get('updatedAt') || 0;
    if (updatedAt >= cur) { this._set('state', state); this._set('updatedAt', updatedAt); }
    if (reminder) this._set('reminder', reminder);
    await this.reschedule();
    return { updatedAt: Math.max(cur, updatedAt) };
  }

  addSub(sub) {
    this.sql.exec('INSERT OR REPLACE INTO subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?)', sub.endpoint, sub.p256dh, sub.auth, Date.now());
    return this.reschedule();
  }
  removeSub(endpoint) { this.sql.exec('DELETE FROM subs WHERE endpoint = ?', endpoint); return this.reschedule(); }
  subCount() { return this.sql.exec('SELECT COUNT(*) AS n FROM subs').one().n; }

  async setRest(seconds) { this._set('restAt', Date.now() + Math.max(5, Math.min(900, seconds)) * 1000); await this.reschedule(); }
  async clearRest() { this._set('restAt', null); await this.reschedule(); }

  status() { return { devices: this.subCount(), nextReminderAt: this._get('nextReminderAt'), restAt: this._get('restAt') }; }

  async reschedule() {
    const now = Date.now();
    const next = this.subCount() ? nextReminder(this._get('reminder'), now) : null;
    this._set('nextReminderAt', next ? next.at : null);
    const restAt = this._get('restAt');
    const times = [next && next.at, restAt].filter(Boolean);
    if (times.length && this.subCount()) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const now = Date.now() + 2000;
    const restAt = this._get('restAt');
    if (restAt && restAt <= now) {
      this._set('restAt', null);
      await this.notify({ title: 'Rest is up', body: 'Time for your next set.', tag: 'rest', ttl: 120 });
    }
    const remAt = this._get('nextReminderAt');
    if (remAt && remAt <= now) {
      const r = this._get('reminder') || {};
      await this.notify({ title: r.title || 'Workout day', body: r.body || 'Open A/B Barbell to see today’s workout.', tag: 'reminder', ttl: 6 * 3600 });
      // Move past this one so it isn't sent twice.
      const after = nextReminder(r, remAt + 60000);
      this._set('nextReminderAt', after ? after.at : null);
    }
    const times = [this._get('nextReminderAt'), this._get('restAt')].filter(Boolean);
    if (times.length && this.subCount()) await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async notify(data) {
    const { vapid } = await this.env.DIR.get(this.env.DIR.idFromName('dir')).keys();
    const subs = this.sql.exec('SELECT * FROM subs').toArray();
    let sent = 0;
    for (const s of subs) {
      try {
        const status = await sendPush(s, data, vapid, PUSH_SUBJECT);
        if (status === 404 || status === 410) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', s.endpoint);
        else if (status < 300) sent++;
      } catch (e) { /* network hiccup: try again next time */ }
    }
    return sent;
  }
}

/* ---------------- HTTP API ---------------- */
async function body(req) { try { return await req.json(); } catch { return {}; } }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await api(req, env, url); }
    catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
  }
};

async function api(req, env, url) {
  const dir = env.DIR.get(env.DIR.idFromName('dir'));
  const rpID = url.hostname;
  const origin = url.origin;
  const path = url.pathname, method = req.method;
  const { secret, vapid } = await dir.keys();
  const signupsOpen = env.ALLOW_SIGNUPS !== 'false';

  if (path === '/api/config' && method === 'GET') {
    return json({ vapidPublicKey: vapid.publicKey, signupsOpen });
  }

  // ---- sign-in with passkeys ----
  if (path === '/api/auth/register/options' && method === 'POST') {
    const b = await body(req);
    const auth = await currentUser(req, dir);
    if (!auth && !signupsOpen) return fail(403, 'New accounts are turned off for this app.');
    const name = auth ? auth.name : String(b.name || '').trim().slice(0, 40);
    if (!name) return fail(400, 'Enter a name for your account.');
    const userId = auth ? auth.id : randomToken(16);
    const options = await generateRegistrationOptions({
      rpName: 'A/B Barbell', rpID, userName: name, userDisplayName: name,
      userID: unb64u(userId), attestationType: 'none',
      excludeCredentials: auth ? await dir.credIds(auth.id) : [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
    });
    const ticket = await signTicket(secret, { c: options.challenge, u: userId, n: name, add: !!auth, exp: Date.now() + 5 * 60000 });
    return json({ options, ticket });
  }
  if (path === '/api/auth/register/verify' && method === 'POST') {
    const b = await body(req);
    const t = await readTicket(secret, b.ticket);
    if (!t) return fail(400, 'That took too long. Try again.');
    const auth = await currentUser(req, dir);
    if (t.add && (!auth || auth.id !== t.u)) return fail(401, 'Sign in again first.');
    const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: t.c, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    if (!v.verified) return fail(400, 'The passkey could not be verified.');
    const c = v.registrationInfo.credential;
    const cred = { id: c.id, publicKey: b64u(c.publicKey), counter: c.counter, transports: c.transports || b.response?.response?.transports || [] };
    if (t.add) { await dir.addCred(t.u, cred); return json({ ok: true }); }
    const recovery = makeRecoveryCode();
    await dir.createUser(t.u, t.n, await sha256(normCode(recovery)), cred);
    const token = await startSession(dir, t.u);
    return json({ token, user: { id: t.u, name: t.n }, recoveryCode: recovery });
  }
  if (path === '/api/auth/login/options' && method === 'POST') {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const ticket = await signTicket(secret, { c: options.challenge, exp: Date.now() + 5 * 60000 });
    return json({ options, ticket });
  }
  if (path === '/api/auth/login/verify' && method === 'POST') {
    const b = await body(req);
    const t = await readTicket(secret, b.ticket);
    if (!t) return fail(400, 'That took too long. Try again.');
    const cred = await dir.getCred(b.response?.id);
    if (!cred) return fail(404, 'No account uses this passkey. Create an account first.');
    const v = await verifyAuthenticationResponse({
      response: b.response, expectedChallenge: t.c, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
      credential: { id: cred.id, publicKey: unb64u(cred.pubkey), counter: cred.counter, transports: cred.transports }
    });
    if (!v.verified) return fail(400, 'The passkey could not be verified.');
    await dir.bumpCounter(cred.id, v.authenticationInfo.newCounter);
    const user = await dir.getUser(cred.user);
    return json({ token: await startSession(dir, user.id), user });
  }
  if (path === '/api/auth/recover' && method === 'POST') {
    const b = await body(req);
    const user = await dir.userByRecovery(await sha256(normCode(b.code)));
    if (!user) return fail(404, 'That recovery code doesn’t match an account. Check it and try again.');
    const recovery = makeRecoveryCode();               // each code works once
    await dir.setRecovery(user.id, await sha256(normCode(recovery)));
    return json({ token: await startSession(dir, user.id), user, recoveryCode: recovery });
  }

  // ---- everything below needs a signed-in user ----
  const user = await currentUser(req, dir);
  if (!user) return fail(401, 'Sign in again.');
  const store = env.USER.get(env.USER.idFromName(user.id));

  if (path === '/api/me' && method === 'GET') return json({ user, ...(await store.status()) });
  if (path === '/api/auth/logout' && method === 'POST') { await dir.endSession(await sha256(bearer(req))); return json({ ok: true }); }

  if (path === '/api/state' && method === 'GET') return json(await store.getState());
  if (path === '/api/state' && method === 'PUT') {
    const b = await body(req);
    if (!b.state || typeof b.updatedAt !== 'number') return fail(400, 'Missing data.');
    if (JSON.stringify(b.state).length > 2_000_000) return fail(413, 'Your log is too large to sync.');
    return json(await store.putState(b.state, b.updatedAt, b.reminder || null));
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const s = (await body(req)).subscription || {};
    if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth || !(/^https:\/\//.test(s.endpoint) || (env.ALLOW_LOCAL_PUSH === 'true' && /^http:\/\/127\.0\.0\.1:/.test(s.endpoint)))) return fail(400, 'That notification setup is incomplete.');
    await store.addSub({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });
    return json({ ok: true, ...(await store.status()) });
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    await store.removeSub((await body(req)).endpoint || '');
    return json({ ok: true });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const sent = await store.notify({ title: 'Notifications are on', body: 'A/B Barbell will remind you on training days and when rest is up.', tag: 'test', ttl: 300 });
    return json({ sent });
  }
  if (path === '/api/rest' && method === 'POST') { await store.setRest(Number((await body(req)).seconds) || 90); return json({ ok: true }); }
  if (path === '/api/rest' && method === 'DELETE') { await store.clearRest(); return json({ ok: true }); }

  return fail(404, 'Not found.');
}

function bearer(req) { return (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''); }
async function currentUser(req, dir) {
  const t = bearer(req);
  return t ? dir.sessionUser(await sha256(t)) : null;
}
async function startSession(dir, userId) {
  const token = randomToken(32);
  await dir.newSession(userId, await sha256(token));
  return token;
}
