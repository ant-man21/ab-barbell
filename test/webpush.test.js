import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, generateVapidKeys, sendPush, b64u, unb64u } from '../worker/src/webpush.js';

function fakeBrowser() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, p256dh: b64u(ecdh.getPublicKey()), authB64: b64u(auth) };
}

test('payload decrypts with an independent RFC 8291 implementation', async () => {
  const b = fakeBrowser();
  const body = await encryptPayload(JSON.stringify({ title: 'Rest is up' }), b.p256dh, b.authB64);
  const out = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: b.ecdh, authSecret: b.auth });
  assert.deepEqual(JSON.parse(out.toString()), { title: 'Rest is up' });
});

test('VAPID header carries a valid ES256 signature for the push origin', async () => {
  const vapid = await generateVapidKeys();
  const b = fakeBrowser();
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(null, { status: 201 }); };
  const status = await sendPush({ endpoint: 'https://web.push.apple.com/abc', p256dh: b.p256dh, auth: b.authB64 }, { title: 't', tag: 'rest' }, vapid, 'https://github.com/ant-man21/ab-barbell');
  assert.equal(status, 201);
  const m = seen.init.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  const claims = JSON.parse(Buffer.from(unb64u(m[2])).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  const pub = await crypto.webcrypto.subtle.importKey('raw', unb64u(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(m[3]), new TextEncoder().encode(m[1] + '.' + m[2]));
  assert.ok(ok);
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
});
