// Encryption for #Encrypted blocks, done entirely in the browser with
// WebCrypto. The server only ever stores scrambled text.
//
// One random 256-bit key (AES-GCM) encrypts every block. That key is stored
// on the server twice, each copy encrypted ("wrapped"): once with a key made
// from your password (PBKDF2-SHA256, 600k rounds) and once with a key made from
// a recovery key shown when the password is first set. Changing the password
// only re-wraps the key, so existing blocks stay readable.
// src/crypto.rs (the terminal reset) must use exactly the same formats.

import { getSetting } from './settings.js';

const PW_ROUNDS = 600000;
const RK_ROUNDS = 100000;
const enc = new TextEncoder();
const dec = new TextDecoder();

let key = null; // CryptoKey while unlocked
let lockTimer = null;

export const ENCRYPTED_TAG = /(^|\s)#(?:encrypted|\[\[encrypted\]\])(?=\s|$)/i;
export const BLOB_PREFIX = 'v1:';

// WebCrypto exists only on HTTPS (or localhost).
export function available() {
  return !!(window.isSecureContext && crypto?.subtle);
}

export function isUnlocked() {
  return !!key;
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function derive(secret, salt, rounds) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function checkOf(raw) {
  const prefix = enc.encode('blockseq-key-check:');
  const buf = new Uint8Array(prefix.length + raw.length);
  buf.set(prefix);
  buf.set(raw, prefix.length);
  return b64(await crypto.subtle.digest('SHA-256', buf));
}

async function wrap(kek, raw) {
  const iv = rand(12);
  return { iv: b64(iv), data: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw)) };
}

async function unwrapRaw(kek, iv, data) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, kek, unb64(data)));
}

const importKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// Recovery keys: 20 random bytes as base32, in groups of four.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function newRecoveryKey() {
  const bytes = rand(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{4}/g).join('-');
}
const normalizeRecovery = (k) => k.replace(/[^a-z0-9]/gi, '').toUpperCase();

// ---- server calls ----

async function fetchConfig() {
  const r = await fetch('/api/encryption');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).encryption;
}

async function saveConfig(encryption, check) {
  const r = await fetch('/api/encryption', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryption, check }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}

export async function isConfigured() {
  return !!(await fetchConfig());
}

// ---- set up, unlock, lock ----

// First-time setup: makes the key, returns the recovery key (show it once).
export async function setUp(password) {
  if (await fetchConfig()) throw new Error('A password is already set');
  const raw = rand(32);
  const salt = rand(16);
  const rkSalt = rand(16);
  const recovery = newRecoveryKey();
  const pw = await wrap(await derive(password, salt, PW_ROUNDS), raw);
  const rk = await wrap(await derive(normalizeRecovery(recovery), rkSalt, RK_ROUNDS), raw);
  await saveConfig({
    version: 1, salt: b64(salt), iterations: PW_ROUNDS, pw_iv: pw.iv, pw_data: pw.data,
    rk_salt: b64(rkSalt), rk_iterations: RK_ROUNDS, rk_iv: rk.iv, rk_data: rk.data, check: await checkOf(raw),
  }, null);
  key = await importKey(raw);
  touch();
  announce('blockseq:unlocked');
  return recovery;
}

async function rawFromPassword(cfg, password) {
  try {
    return await unwrapRaw(await derive(password, unb64(cfg.salt), cfg.iterations), cfg.pw_iv, cfg.pw_data);
  } catch {
    throw new Error('Wrong password');
  }
}

async function rawFromRecovery(cfg, recovery) {
  try {
    return await unwrapRaw(await derive(normalizeRecovery(recovery), unb64(cfg.rk_salt), cfg.rk_iterations), cfg.rk_iv, cfg.rk_data);
  } catch {
    throw new Error("That recovery key doesn't match");
  }
}

export async function unlock(password) {
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('No encryption password is set yet (Settings → Security)');
  key = await importKey(await rawFromPassword(cfg, password));
  touch();
  announce('blockseq:unlocked');
}

// New password, proving the old one (or the recovery key) first.
export async function changePassword({ current, recovery }, password) {
  const cfg = await fetchConfig();
  if (!cfg) throw new Error('No encryption password is set yet');
  const raw = recovery ? await rawFromRecovery(cfg, recovery) : await rawFromPassword(cfg, current);
  const salt = rand(16);
  const pw = await wrap(await derive(password, salt, PW_ROUNDS), raw);
  await saveConfig({ ...cfg, salt: b64(salt), iterations: PW_ROUNDS, pw_iv: pw.iv, pw_data: pw.data }, cfg.check);
  key = await importKey(raw);
  touch();
  announce('blockseq:unlocked');
}

// Editors first save (encrypting with the key one last time), then the key
// and every decrypted text are dropped.
export async function lock() {
  if (!key) return;
  clearTimeout(lockTimer);
  const ev = new CustomEvent('blockseq:locking', { detail: { wait: [] } });
  document.dispatchEvent(ev);
  await Promise.allSettled(ev.detail.wait);
  key = null;
  announce('blockseq:locked');
}

function announce(name) {
  document.dispatchEvent(new CustomEvent(name));
}

// Locks after the idle time in Settings (minutes; 0 = only when the tab closes).
function touch() {
  clearTimeout(lockTimer);
  const minutes = Number(getSetting('lockMinutes'));
  if (key && minutes > 0) lockTimer = setTimeout(lock, minutes * 60000);
}
for (const ev of ['keydown', 'mousedown', 'touchstart']) document.addEventListener(ev, () => { if (key) touch(); }, { passive: true });

// ---- encrypting text ----

export async function encryptText(text) {
  if (!key) throw new Error('locked');
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return `${BLOB_PREFIX}${b64(iv)}:${b64(ct)}`;
}

async function decryptWith(k, blob) {
  const [, iv, ct] = blob.split(':');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, k, unb64(ct));
  return dec.decode(pt);
}

export async function decryptText(blob) {
  if (!key) throw new Error('locked');
  return decryptWith(key, blob);
}

// ---- re-encrypting a restored backup ----
//
// A backup restored onto a server with a different password keeps its own
// (wrapped) key. Its password or recovery key opens that old key here, and
// every block is re-encrypted with the current one.

export async function keyFromSetup(cfg, { password, recovery }) {
  return importKey(recovery ? await rawFromRecovery(cfg, recovery) : await rawFromPassword(cfg, password));
}

const BLOB_RE = /(encrypted:: )(v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+)/g;

// Re-encrypts every blob in `text` (and blobs nested inside them) from
// `oldKey` to the current key. Blobs already on the current key are kept.
export async function rekeyText(oldKey, text) {
  if (!key) throw new Error('locked');
  let count = 0;
  let failed = 0;
  const out = [];
  let last = 0;
  for (const m of text.matchAll(BLOB_RE)) {
    out.push(text.slice(last, m.index), m[1]);
    last = m.index + m[0].length;
    let plain;
    try {
      plain = await decryptWith(oldKey, m[2]);
    } catch {
      try { await decryptWith(key, m[2]); } catch { failed++; }
      out.push(m[2]);
      continue;
    }
    const inner = await rekeyText(oldKey, plain);
    count += inner.count + 1;
    failed += inner.failed;
    out.push(await encryptText(inner.text));
  }
  out.push(text.slice(last));
  return { text: out.join(''), count, failed };
}
