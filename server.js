'use strict';

/**
 * EchoTag — record a voice note, get a QR code, play it from any phone.
 *
 * Zero-database: recordings live in ./data/recordings as an audio file plus
 * a small JSON sidecar. QR codes point at /p/<code>.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Load .env next to this file if present (Node 20.12+). Missing file is fine.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read .env:', err.message);
  }
}

const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { BlobNotFoundError, del, head, list, put } = require('@vercel/blob');

const APP_NAME = 'EchoTag';
const PORT = Number(process.env.PORT) || 3000;
const ON_VERCEL = Boolean(process.env.VERCEL);
const BLOB_TOKEN = (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const BLOB_STORE_ID = (process.env.BLOB_STORE_ID || '').trim();
const BLOB_ENABLED = Boolean(BLOB_TOKEN || BLOB_STORE_ID);
const STORAGE_MODE = BLOB_ENABLED ? 'blob' : ON_VERCEL ? 'unavailable' : 'file';
const MAX_SECONDS = clampNumber(
  Number(process.env.MAX_RECORDING_SECONDS),
  5,
  3600,
  ON_VERCEL ? 180 : 300,
);
const MAX_BYTES = Math.round(
  clampNumber(Number(process.env.MAX_UPLOAD_MB), 0.5, 100, ON_VERCEL ? 4 : 25) * 1024 * 1024,
);
const RETENTION_DAYS = clampNumber(Number(process.env.RETENTION_DAYS), 0, 3650, 30);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || ON_VERCEL;
const CRON_SECRET = process.env.CRON_SECRET || '';

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();
const ADMIN_USERS = (process.env.ADMIN_USERS || '').trim();
const ADMIN_SESSION_SECRET = (process.env.ADMIN_SESSION_SECRET || '').trim();
const ADMIN_COOKIE = 'echotag_admin';
const ADMIN_LOGIN_CSRF_COOKIE = 'echotag_admin_login';
const ADMIN_SESSION_VERSION = 'v1';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_CSRF_TTL_MS = 30 * 60 * 1000;
const ADMIN_LOGIN_LIMIT = 8;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const DATA_DIR = path.join(__dirname, 'data', 'recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_URL_PATH = __dirname;
const BLOB_META_PREFIX = 'echotag/meta/';
const BLOB_AUDIO_PREFIX = 'echotag/audio/';

if (STORAGE_MODE === 'file') fs.mkdirSync(DATA_DIR, { recursive: true });

let activePort = PORT;

const AUDIO_MIME_EXT = {
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mpeg': '.mp3',
};
const ALLOWED_EXTS = new Set(Object.values(AUDIO_MIME_EXT));
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_PATTERN = /^[a-z0-9]{6,16}$/;

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self)',
  });
  next();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function normalizeBase(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function pickLanIp() {
  const preferred = [];
  const fallback = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (/^192\.168\./.test(address.address)) preferred.push(address.address);
      else if (/^10\./.test(address.address)) preferred.push(address.address);
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address.address)) preferred.push(address.address);
      else fallback.push(address.address);
    }
  }
  return preferred[0] || fallback[0] || null;
}

function requestOrigin(req) {
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : req.protocol || 'http';
  const host = req.get('host') || `localhost:${activePort}`;
  return `${protocol}://${host}`;
}

function defaultBaseFor(req) {
  const envBase = normalizeBase(PUBLIC_BASE_URL);
  if (envBase) return envBase;

  const origin = normalizeBase(requestOrigin(req));
  if (origin) {
    const hostname = new URL(origin).hostname;
    if (!isLoopbackHostname(hostname)) return origin;
  }

  const lanIp = pickLanIp();
  if (lanIp) return `http://${lanIp}:${activePort}`;
  return origin || `http://localhost:${activePort}`;
}

function randomCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function cleanTitle(raw) {
  const cleaned = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/-->/g, '—>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Voice note';
}

function parsePeaks(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, 120)
      .map((value) => clampNumber(Number(value), 0, 1, 0))
      .map((value) => Math.round(value * 1000) / 1000)
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

function sniffAudioMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'audio/webm';
  }
  if (buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';

  return null;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function fallbackPeaks(code) {
  let seed = 0;
  for (const char of code) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: 56 }, (_, index) => {
    const envelope = 0.45 + 0.35 * Math.sin((index / 56) * Math.PI * 2.5);
    return Math.max(0.12, Math.min(1, envelope * (0.55 + random() * 0.7)));
  });
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function extensionFor(meta) {
  return ALLOWED_EXTS.has(meta.ext) ? meta.ext : AUDIO_MIME_EXT[meta.mime] || '.webm';
}

function audioPathFor(meta) {
  return path.join(DATA_DIR, `${meta.code}${extensionFor(meta)}`);
}

function blobMetaPathname(code) {
  return `${BLOB_META_PREFIX}${code}.json`;
}

function blobAudioPathname(meta) {
  return `${BLOB_AUDIO_PREFIX}${meta.code}${extensionFor(meta)}`;
}

function isBlobMissing(err) {
  return err instanceof BlobNotFoundError || (err && (err.name === 'BlobNotFoundError' || err.statusCode === 404));
}

function parseMeta(value, code) {
  if (!value || value.code !== code || !value.mime) return null;
  return value;
}

async function readMetaFromBlob(code) {
  let info;
  try {
    info = await head(blobMetaPathname(code), { token: BLOB_TOKEN });
  } catch (err) {
    if (isBlobMissing(err)) return null;
    throw err;
  }

  try {
    const response = await fetch(info.url, { cache: 'no-store' });
    if (!response.ok) return null;
    return parseMeta(await response.json(), code);
  } catch {
    return null;
  }
}

async function readMeta(code) {
  if (!CODE_PATTERN.test(String(code || ''))) return null;
  if (STORAGE_MODE === 'unavailable') return null;
  if (STORAGE_MODE === 'blob') return readMetaFromBlob(code);

  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, `${code}.json`), 'utf8');
    return parseMeta(JSON.parse(raw), code);
  } catch {
    return null;
  }
}

function compareRecordings(a, b) {
  const left = Date.parse(a.createdAt) || 0;
  const right = Date.parse(b.createdAt) || 0;
  if (right !== left) return right - left;
  return String(a.code).localeCompare(String(b.code));
}

async function listRecordingsFromBlob() {
  const recordings = [];
  let cursor;

  do {
    const page = await list({
      prefix: BLOB_META_PREFIX,
      cursor,
      limit: 1000,
      token: BLOB_TOKEN,
    });

    const sidecars = page.blobs.filter((blob) => blob.pathname.endsWith('.json'));
    for (let index = 0; index < sidecars.length; index += 8) {
      const batch = sidecars.slice(index, index + 8);
      const results = await Promise.allSettled(batch.map(async (blob) => {
        const code = blob.pathname.slice(BLOB_META_PREFIX.length, -'.json'.length);
        if (!CODE_PATTERN.test(code)) return null;
        const response = await fetch(blob.url, { cache: 'no-store' });
        if (!response.ok) return null;
        return parseMeta(await response.json(), code);
      }));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) recordings.push(result.value);
      }
    }

    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return recordings.sort(compareRecordings);
}

async function listRecordingsFromDisk() {
  let names;
  try {
    names = await fsp.readdir(DATA_DIR);
  } catch {
    return [];
  }

  const recordings = [];
  await Promise.all(names.map(async (name) => {
    if (!name.endsWith('.json')) return;
    const code = name.slice(0, -'.json'.length);
    if (!CODE_PATTERN.test(code)) return;
    try {
      const raw = await fsp.readFile(path.join(DATA_DIR, name), 'utf8');
      const meta = parseMeta(JSON.parse(raw), code);
      if (meta) recordings.push(meta);
    } catch {
      // Ignore unreadable sidecars; they cannot be managed safely.
    }
  }));

  return recordings.sort(compareRecordings);
}

async function listRecordings() {
  if (STORAGE_MODE === 'unavailable') return [];
  if (STORAGE_MODE === 'blob') return listRecordingsFromBlob();
  return listRecordingsFromDisk();
}

async function getPlayableRecording(code) {
  const meta = await readMeta(code);
  if (!meta) return null;
  if (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) {
    await removeRecording(meta);
    return null;
  }

  if (STORAGE_MODE === 'blob') {
    if (!meta.audioUrl) return null;
    try {
      await head(meta.audioUrl, { token: BLOB_TOKEN });
    } catch (err) {
      if (isBlobMissing(err)) return null;
      throw err;
    }
    return meta;
  }

  try {
    const stat = await fsp.stat(audioPathFor(meta));
    if (!stat.isFile() || stat.size === 0) return null;
  } catch {
    return null;
  }
  return meta;
}

async function writeMeta(meta) {
  const target = path.join(DATA_DIR, `${meta.code}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(meta, null, 2));
  await fsp.rename(temp, target);
}

async function saveRecording(meta, buffer) {
  if (STORAGE_MODE === 'blob') {
    const audio = await put(blobAudioPathname(meta), buffer, {
      access: 'public',
      contentType: meta.mime,
      addRandomSuffix: false,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
      token: BLOB_TOKEN,
    });

    meta.audioUrl = audio.url;

    try {
      await put(blobMetaPathname(meta.code), JSON.stringify(meta, null, 2), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        cacheControlMaxAge: 60 * 60,
        token: BLOB_TOKEN,
      });
    } catch (err) {
      await del(audio.url, { token: BLOB_TOKEN }).catch(() => {});
      throw err;
    }
    return meta;
  }

  const audioPath = audioPathFor(meta);
  await fsp.writeFile(audioPath, buffer);
  try {
    await writeMeta(meta);
  } catch (err) {
    await fsp.unlink(audioPath).catch(() => {});
    throw err;
  }
  return meta;
}

async function removeRecording(meta) {
  if (STORAGE_MODE === 'blob') {
    try {
      await del([blobMetaPathname(meta.code), blobAudioPathname(meta)], { token: BLOB_TOKEN });
    } catch (err) {
      if (!isBlobMissing(err)) console.warn(`Cleanup warning for ${meta.code}:`, err.message);
    }
    return;
  }

  const results = await Promise.allSettled([
    fsp.unlink(audioPathFor(meta)),
    fsp.unlink(path.join(DATA_DIR, `${meta.code}.json`)),
  ]);
  for (const result of results) {
    if (result.status === 'rejected' && result.reason && result.reason.code !== 'ENOENT') {
      console.warn(`Cleanup warning for ${meta.code}:`, result.reason.message);
    }
  }
}

async function allocateCode() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = randomCode(8);

    if (STORAGE_MODE === 'blob') {
      try {
        await head(blobMetaPathname(code), { token: BLOB_TOKEN });
      } catch (err) {
        if (isBlobMissing(err)) return code;
        throw err;
      }
      continue;
    }

    if (!fs.existsSync(path.join(DATA_DIR, `${code}.json`))) return code;
  }
  throw httpError(503, 'Could not allocate a link. Please try again.');
}

async function sweepExpired() {
  if (STORAGE_MODE === 'unavailable') return;

  if (STORAGE_MODE === 'blob') {
    let cursor;
    do {
      const page = await list({
        prefix: BLOB_META_PREFIX,
        cursor,
        limit: 1000,
        token: BLOB_TOKEN,
      });

      for (const blob of page.blobs) {
        if (!blob.pathname.endsWith('.json')) continue;
        try {
          const response = await fetch(blob.url, { cache: 'no-store' });
          if (!response.ok) continue;
          const meta = await response.json();
          if (!meta || !meta.code || !meta.expiresAt) continue;
          if (Date.parse(meta.expiresAt) <= Date.now()) await removeRecording(meta);
        } catch {
          // Ignore unreadable sidecars; they are harmless.
        }
      }

      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return;
  }

  let names;
  try {
    names = await fsp.readdir(DATA_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(DATA_DIR, name), 'utf8'));
      if (meta.expiresAt && Date.parse(meta.expiresAt) <= now) await removeRecording(meta);
    } catch {
      // Ignore unreadable sidecars; they are harmless.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting (lightweight, per IP)                                 */
/* ------------------------------------------------------------------ */

function createLimiter({ limit, windowMs, message, onLimit }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  timer.unref();

  function limiter(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      if (typeof onLimit === 'function') return onLimit(req, res, message);
      return res.status(429).json({ error: message });
    }
    return next();
  }

  limiter.reset = (key) => buckets.delete(key);
  return limiter;
}

const uploadLimiter = createLimiter({
  limit: 30,
  windowMs: 10 * 60 * 1000,
  message: 'Too many recordings from this device. Please wait a few minutes.',
});

/* ------------------------------------------------------------------ */
/* Admin authentication                                                */
/* ------------------------------------------------------------------ */

function parsePasswordHash(stored) {
  const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
    String(stored || ''),
  );
  if (!match) return null;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;

  const salt = Buffer.from(match[4], 'base64url');
  const key = Buffer.from(match[5], 'base64url');
  if (salt.length < 16 || key.length < 32 || key.length > SCRYPT_KEYLEN) return null;

  return { N, r, p, salt, key };
}

async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;

  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      parsed.salt,
      parsed.key.length,
      { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

  return derived.length === parsed.key.length && crypto.timingSafeEqual(derived, parsed.key);
}

function isUsableAdminUsername(username) {
  return Boolean(username)
    && username.length <= 80
    && !/[\u0000-\u001f\u007f:]/.test(username);
}

const ADMIN_ACCOUNTS = (() => {
  const accounts = new Map();
  const add = (username, hash) => {
    const name = String(username || '').trim();
    const value = String(hash || '').trim();
    if (!isUsableAdminUsername(name) || !parsePasswordHash(value)) return false;
    if (!accounts.has(name)) {
      accounts.set(name, {
        username: name,
        hash: value,
        fingerprint: sha256(value).slice(0, 32),
      });
    }
    return true;
  };

  if (ADMIN_USERNAME || ADMIN_PASSWORD_HASH) add(ADMIN_USERNAME, ADMIN_PASSWORD_HASH);
  for (const entry of ADMIN_USERS.split(/[\r\n,]+/)) {
    const separator = entry.indexOf(':');
    if (separator < 1) continue;
    add(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return accounts;
})();

const ADMIN_CONFIG_ISSUE = (() => {
  if (!ADMIN_USERNAME && !ADMIN_PASSWORD_HASH && !ADMIN_USERS && !ADMIN_SESSION_SECRET) {
    return 'Admin is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET.';
  }
  if (ADMIN_SESSION_SECRET.length < 32) {
    return 'ADMIN_SESSION_SECRET must be at least 32 characters.';
  }
  if (ADMIN_ACCOUNTS.size === 0) {
    return 'No valid admin accounts are configured. Check ADMIN_USERNAME/ADMIN_PASSWORD_HASH and ADMIN_USERS.';
  }
  return null;
})();
const ADMIN_CONFIGURED = ADMIN_CONFIG_ISSUE === null;
// Used to spend the same scrypt time when a username does not exist.
const ADMIN_TIMING_HASH = ADMIN_ACCOUNTS.values().next().value?.hash || '';

function parseCookies(req) {
  const header = req.get('cookie') || '';
  const cookies = Object.create(null);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    let value = part.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value if it is not valid percent-encoding.
    }
    cookies[name] = value;
  }
  return cookies;
}

function requestIsSecure(req) {
  if (req.secure) return true;
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return forwardedProto === 'https';
}

function buildCookie(req, name, value, maxAgeSeconds, path = '/') {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (requestIsSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function adminCookie(req, value, maxAgeSeconds) {
  return buildCookie(req, ADMIN_COOKIE, value, maxAgeSeconds);
}

function adminLoginCsrfCookie(req, value, maxAgeSeconds) {
  return buildCookie(req, ADMIN_LOGIN_CSRF_COOKIE, value, maxAgeSeconds, '/admin');
}

function adminHmac(context, value) {
  return crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(`${context}:${value}`).digest('base64url');
}

function createAdminSession(account) {
  const issuedAt = Date.now();
  const payload = {
    v: 1,
    u: account.username,
    f: account.fingerprint,
    iat: issuedAt,
    exp: issuedAt + ADMIN_SESSION_TTL_MS,
    csrf: crypto.randomBytes(24).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = adminHmac('session-v1', body);
  return { token: `${ADMIN_SESSION_VERSION}.${body}.${signature}`, payload };
}

function readAdminSession(req) {
  if (!ADMIN_CONFIGURED) return null;
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== ADMIN_SESSION_VERSION) return null;
  if (!safeEqual(parts[2], adminHmac('session-v1', parts[1]))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || payload.v !== 1) return null;
  const account = ADMIN_ACCOUNTS.get(payload.u);
  if (!account || payload.f !== account.fingerprint) return null;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
  const now = Date.now();
  if (payload.exp <= now || payload.iat > now + 60_000) return null;
  if (payload.exp - payload.iat > ADMIN_SESSION_TTL_MS + 60_000) return null;
  if (typeof payload.csrf !== 'string' || payload.csrf.length < 20) return null;
  return payload;
}

function issueAdminLoginCsrf(req, res) {
  const issuedAt = Date.now();
  const nonce = crypto.randomBytes(18).toString('base64url');
  const body = `${issuedAt}.${nonce}`;
  if (res) {
    res.append('Set-Cookie', adminLoginCsrfCookie(
      req,
      nonce,
      Math.floor(ADMIN_LOGIN_CSRF_TTL_MS / 1000),
    ));
  }
  return `${body}.${adminHmac('login-v1', body)}`;
}

function verifyAdminLoginCsrfToken(token) {
  if (typeof token !== 'string' || token.length > 300) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const issuedAt = Number(parts[0]);
  if (!Number.isFinite(issuedAt)) return false;
  const now = Date.now();
  if (issuedAt > now + 60_000 || now - issuedAt > ADMIN_LOGIN_CSRF_TTL_MS) return false;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(parts[1])) return false;
  return safeEqual(parts[2], adminHmac('login-v1', `${parts[0]}.${parts[1]}`));
}

function loginCsrfCookieMatches(req, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const cookieNonce = parseCookies(req)[ADMIN_LOGIN_CSRF_COOKIE] || '';
  return Boolean(cookieNonce) && safeEqual(cookieNonce, parts[1]);
}

function isSameOriginRequest(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  const candidate = normalizeBase(origin);
  if (!candidate) return false;

  const expected = normalizeBase(requestOrigin(req));
  if (expected && candidate === expected) return true;
  const envBase = normalizeBase(PUBLIC_BASE_URL);
  return Boolean(envBase && candidate === envBase);
}

function mediaOriginsFor(recordings) {
  const origins = new Set();
  for (const meta of recordings) {
    if (!meta.audioUrl) continue;
    try {
      const url = new URL(meta.audioUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
    } catch {
      // Ignore malformed legacy URLs.
    }
  }
  return [...origins];
}

function adminContentSecurityPolicy(mediaOrigins = []) {
  const media = ["'self'", ...mediaOrigins].join(' ');
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    `media-src ${media}`,
    "connect-src 'self'",
    "font-src 'self'",
  ].join('; ');
}

function sendAdminPage(res, status, html, mediaOrigins = []) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': adminContentSecurityPolicy(mediaOrigins),
  });
  res.status(status).type('html').send(html);
}

function adminRedirect(res, location) {
  res.set('Cache-Control', 'no-store');
  res.redirect(303, location);
}

function requireAdminConfigured(req, res, next) {
  if (!ADMIN_CONFIGURED) {
    sendAdminPage(res, 503, renderAdminErrorPage(
      'Admin is not configured',
      'This deployment has no admin credentials yet. Add ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET, then redeploy.',
      '/',
      'Back to EchoTag',
    ));
    return;
  }
  next();
}

function requireAdminSession(req, res, next) {
  const session = readAdminSession(req);
  if (!session) {
    res.redirect(303, '/admin');
    return;
  }
  req.adminSession = session;
  next();
}

function requireAdminCsrf(req, res, next) {
  if (!isSameOriginRequest(req)) {
    // The signed session and per-session CSRF token remain the hard checks.
    // Log the mismatch instead of locking out users behind proxies or webviews.
    console.warn(`Admin request with a cross-origin header from ${req.ip || 'unknown'}`);
  }

  const supplied = String(
    req.get('x-csrf-token') || (req.body && req.body._csrf) || '',
  ).trim();
  if (!supplied || !safeEqual(supplied, req.adminSession.csrf)) {
    sendAdminPage(res, 403, renderAdminErrorPage(
      'Request blocked',
      'Your security token was missing or out of date. Reload the console and try again.',
      '/admin',
      'Back to the console',
    ));
    return;
  }
  next();
}

const adminForm = express.urlencoded({ extended: false, limit: '16kb' });

const loginLimiter = createLimiter({
  limit: ADMIN_LOGIN_LIMIT,
  windowMs: ADMIN_LOGIN_WINDOW_MS,
  message: 'Too many sign-in attempts. Wait 15 minutes, then try again.',
  onLimit(req, res, message) {
    sendAdminPage(res, 429, renderAdminErrorPage(
      'Too many attempts',
      message,
      '/admin',
      'Try again later',
    ));
  },
});

/* ------------------------------------------------------------------ */
/* Upload handling                                                     */
/* ------------------------------------------------------------------ */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 12 },
  fileFilter(req, file, callback) {
    if (file.fieldname !== 'audio') {
      callback(httpError(400, 'Unexpected file upload.'));
      return;
    }
    callback(null, true);
  },
});

async function streamLocalAudio(req, res, next, meta, cacheControl) {
  let stat;
  try {
    stat = await fsp.stat(audioPathFor(meta));
  } catch {
    next(httpError(404, 'Recording not found.'));
    return;
  }

  if (!stat.isFile() || stat.size === 0) {
    next(httpError(404, 'Recording not found.'));
    return;
  }

  const size = stat.size;
  const ext = extensionFor(meta);
  const baseHeaders = {
    'Content-Type': meta.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Content-Disposition': `inline; filename="${APP_NAME.toLowerCase()}-${meta.code}${ext}"`,
  };

  const rangeHeader = req.get('range');
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (match[1] === '' && match[2] === '')) {
      res.set('Content-Range', `bytes */${size}`).status(416).end();
      return;
    }
    let start;
    let end;
    if (match[1] === '') {
      const suffixLength = Number(match[2]);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.set('Content-Range', `bytes */${size}`).status(416).end();
        return;
      }
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Number(match[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.set('Content-Range', `bytes */${size}`).status(416).end();
      return;
    }
    end = Math.min(end, size - 1);
    res.status(206).set({
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(audioPathFor(meta), { start, end })
      .on('error', next)
      .pipe(res);
    return;
  }

  res.status(200).set({ ...baseHeaders, 'Content-Length': String(size) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(audioPathFor(meta))
    .on('error', next)
    .pipe(res);
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/config', (req, res) => {
  const lanIp = pickLanIp();
  res.json({
    defaultBaseUrl: defaultBaseFor(req),
    lanUrls: lanIp && !ON_VERCEL ? [`http://${lanIp}:${activePort}`] : [],
    maxSeconds: MAX_SECONDS,
    retentionDays: RETENTION_DAYS,
    maxBytes: MAX_BYTES,
    storage: STORAGE_MODE,
    uploadEnabled: STORAGE_MODE !== 'unavailable',
  });
});

function requireStorage(req, res, next) {
  if (STORAGE_MODE === 'unavailable') {
    res.status(503).json({
      error: 'Storage is not connected. Add a Vercel Blob store to this project, then redeploy.',
    });
    return;
  }
  next();
}

app.post('/api/recordings', uploadLimiter, requireStorage, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.size) throw httpError(400, 'No audio was uploaded.');
    if (req.file.size < 100) throw httpError(400, 'That audio file looks empty.');
    if (req.file.size > MAX_BYTES) throw httpError(413, 'That recording is too large.');

    const mime = sniffAudioMime(req.file.buffer);
    if (!mime) throw httpError(415, 'Unsupported audio format. Please record again in your browser.');

    const ext = AUDIO_MIME_EXT[mime];
    const duration = clampNumber(Number(req.body.duration), 0, MAX_SECONDS, 0);
    const title = cleanTitle(req.body.title);
    const peaks = parsePeaks(req.body.peaks);
    const autoplay = req.body.autoplay === '1' || req.body.autoplay === 'true';
    const code = await allocateCode();
    const createdAt = new Date();
    const expiresAt = RETENTION_DAYS > 0
      ? new Date(createdAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
      : null;
    const deleteToken = crypto.randomBytes(24).toString('base64url');

    const meta = {
      code,
      title,
      mime,
      ext,
      size: req.file.size,
      duration: Math.round(duration * 10) / 10,
      peaks,
      autoplay,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      deleteTokenHash: sha256(deleteToken),
    };

    await saveRecording(meta, req.file.buffer);

    res.status(201).json({
      code,
      title,
      playPath: `/p/${code}`,
      duration: meta.duration,
      size: meta.size,
      autoplay,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      deleteToken,
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/recordings/:code', async (req, res, next) => {
  try {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) throw httpError(403, 'A delete token is required.');

    const meta = await readMeta(req.params.code);
    if (!meta) {
      res.status(204).end();
      return;
    }
    if (!meta.deleteTokenHash || !safeEqual(sha256(token), meta.deleteTokenHash)) {
      throw httpError(403, 'That delete token is not valid.');
    }

    await removeRecording(meta);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get('/api/recordings/:code/qr.png', async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!CODE_PATTERN.test(code)) throw httpError(404, 'Recording not found.');

    const meta = await getPlayableRecording(code);
    if (!meta) throw httpError(404, 'Recording not found.');

    const base = normalizeBase(String(req.query.base || '')) || defaultBaseFor(req);
    const playUrl = `${base}/p/${meta.code}`;
    const png = await QRCode.toBuffer(playUrl, {
      type: 'png',
      width: 1000,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b12ff', light: '#ffffffff' },
    });

    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${APP_NAME.toLowerCase()}-${meta.code}.png"`,
    });
    res.send(png);
  } catch (err) {
    next(err);
  }
});

app.get('/p/:code', async (req, res) => {
  const meta = await getPlayableRecording(req.params.code);
  if (!meta) {
    res.status(404).type('html').send(renderErrorPage(
      'This voice note has floated away.',
      'It may have expired or been deleted. You can record a new one in a few seconds.',
    ));
    return;
  }

  const mediaSources = ["'self'"];
  if (meta.audioUrl) {
    try {
      mediaSources.push(new URL(meta.audioUrl).origin);
    } catch {
      // Ignore a malformed legacy URL; the proxied /media path still works.
    }
  }

  res.set({
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; media-src ${mediaSources.join(' ')}; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.type('html').send(renderPlayPage(meta, req));
});

app.get('/media/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!CODE_PATTERN.test(code)) throw httpError(404, 'Recording not found.');

    const meta = await getPlayableRecording(code);
    if (!meta) throw httpError(404, 'Recording not found.');

    if (STORAGE_MODE === 'blob') {
      if (!meta.audioUrl) throw httpError(404, 'Recording not found.');
      res.set('Cache-Control', 'public, max-age=300');
      res.redirect(302, meta.audioUrl);
      return;
    }

    await streamLocalAudio(req, res, next, meta, 'public, max-age=31536000, immutable');
  } catch (err) {
    next(err);
  }
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), storage: STORAGE_MODE });
});

app.get('/api/cron/sweep', async (req, res, next) => {
  try {
    if (CRON_SECRET) {
      const expected = `Bearer ${CRON_SECRET}`;
      const received = req.get('authorization') || '';
      if (!safeEqual(received, expected)) throw httpError(401, 'Unauthorized.');
    } else if (ON_VERCEL) {
      throw httpError(503, 'Set CRON_SECRET to enable scheduled cleanup.');
    }

    await sweepExpired();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Admin routes                                                       */
/* ------------------------------------------------------------------ */

app.get('/admin', requireAdminConfigured, (req, res) => {
  if (readAdminSession(req)) {
    adminRedirect(res, '/admin/dashboard');
    return;
  }
  sendAdminPage(res, 200, renderAdminLoginPage({
    csrf: issueAdminLoginCsrf(req, res),
    error: '',
  }));
});

app.post('/admin/login', requireAdminConfigured, loginLimiter, adminForm, async (req, res, next) => {
  try {
    if (!isSameOriginRequest(req)) {
      console.warn(`Admin sign-in with a cross-origin header from ${req.ip || 'unknown'}`);
    }

    const body = req.body || {};
    const tokenOk = verifyAdminLoginCsrfToken(body._csrf);
    const cookieOk = tokenOk && loginCsrfCookieMatches(req, body._csrf);
    if (!tokenOk) {
      sendAdminPage(res, 400, renderAdminLoginPage({
        csrf: issueAdminLoginCsrf(req, res),
        error: 'That sign-in form expired. Reload the page and try again.',
      }));
      return;
    }
    if (!cookieOk && !isSameOriginRequest(req)) {
      console.warn(`Admin sign-in was missing its CSRF cookie from ${req.ip || 'unknown'}`);
      sendAdminPage(res, 403, renderAdminErrorPage(
        'Request blocked',
        'The sign-in request did not come from this site. Reload the page and try again.',
        '/admin',
        'Back to sign in',
      ));
      return;
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const account = typeof username === 'string' && username.length <= 80
      ? ADMIN_ACCOUNTS.get(username)
      : undefined;
    const passwordOk = password.length <= 256
      ? await verifyPassword(password, account ? account.hash : ADMIN_TIMING_HASH)
      : false;

    if (!account || !passwordOk) {
      console.warn(`Admin sign-in failed from ${req.ip || 'unknown'}`);
      sendAdminPage(res, 401, renderAdminLoginPage({
        csrf: issueAdminLoginCsrf(req, res),
        error: 'Incorrect username or password.',
      }));
      return;
    }

    loginLimiter.reset(req.ip || 'unknown');
    const session = createAdminSession(account);
    res.append('Set-Cookie', adminLoginCsrfCookie(req, '', 0));
    res.append('Set-Cookie', adminCookie(req, session.token, Math.floor(ADMIN_SESSION_TTL_MS / 1000)));
    adminRedirect(res, '/admin/dashboard');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/logout', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, (req, res) => {
  res.append('Set-Cookie', adminCookie(req, '', 0));
  adminRedirect(res, '/admin');
});

app.get('/admin/dashboard', requireAdminConfigured, requireAdminSession, async (req, res, next) => {
  try {
    let recordings = [];
    let listError = '';

    if (STORAGE_MODE === 'unavailable') {
      listError = 'Storage is not connected on this deployment, so recordings cannot be listed.';
    } else {
      try {
        recordings = await listRecordings();
      } catch (err) {
        console.error('Could not list recordings:', err);
        listError = 'Recordings could not be loaded right now. Refresh to try again.';
      }
    }

    const status = ['deleted', 'missing', 'error'].includes(String(req.query.status || ''))
      ? String(req.query.status)
      : '';
    const storageLabel = STORAGE_MODE === 'blob'
      ? 'Vercel Blob'
      : STORAGE_MODE === 'file'
        ? 'Local disk'
        : 'Not connected';

    sendAdminPage(res, 200, renderAdminDashboard({
      recordings,
      csrf: req.adminSession.csrf,
      status,
      listError,
      storageLabel,
    }), mediaOriginsFor(recordings));
  } catch (err) {
    next(err);
  }
});

app.get('/admin/audio/:code', requireAdminConfigured, async (req, res, next) => {
  try {
    if (!readAdminSession(req)) {
      res.set('Cache-Control', 'private, no-store').status(401).type('text/plain').send('Sign in to listen.');
      return;
    }

    const code = String(req.params.code);
    if (!CODE_PATTERN.test(code)) throw httpError(404, 'Recording not found.');
    const meta = await readMeta(code);
    if (!meta) throw httpError(404, 'Recording not found.');
    if (STORAGE_MODE === 'unavailable') throw httpError(503, 'Storage is not connected.');

    res.set('Cache-Control', 'private, no-store');
    if (STORAGE_MODE === 'blob') {
      if (!meta.audioUrl) throw httpError(404, 'Recording not found.');
      let audioUrl;
      try {
        audioUrl = new URL(meta.audioUrl);
      } catch {
        throw httpError(404, 'Recording not found.');
      }
      if (audioUrl.protocol !== 'https:' && audioUrl.protocol !== 'http:') {
        throw httpError(404, 'Recording not found.');
      }
      res.redirect(302, audioUrl.toString());
      return;
    }

    await streamLocalAudio(req, res, next, meta, 'private, no-store');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/recordings/:code/delete', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!CODE_PATTERN.test(code)) {
      adminRedirect(res, '/admin/dashboard?status=missing');
      return;
    }

    const meta = await readMeta(code);
    if (!meta) {
      adminRedirect(res, '/admin/dashboard?status=missing');
      return;
    }

    await removeRecording(meta);
    adminRedirect(res, '/admin/dashboard?status=deleted');
  } catch (err) {
    console.error('Admin delete failed:', err);
    adminRedirect(res, '/admin/dashboard?status=error');
  }
});

app.use('/admin', (req, res) => {
  sendAdminPage(res, 404, renderAdminErrorPage(
    'Admin page not found',
    'That page does not exist in the admin console.',
    '/admin',
    'Back to the console',
  ));
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((req, res) => {
  res.status(404).type('html').send(renderErrorPage(
    'Page not found.',
    'That link does not point anywhere. Head back home to record a voice note.',
  ));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'That recording is too large. Try a shorter note.' });
      return;
    }
    res.status(400).json({ error: 'The upload could not be processed.' });
    return;
  }

  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
    return;
  }
  if (req.path.startsWith('/admin/audio/')) {
    res.status(status).type('text/plain').send(status >= 500 ? 'Playback failed.' : 'Recording not found.');
    return;
  }
  if (req.path === '/admin' || req.path.startsWith('/admin/')) {
    sendAdminPage(res, status, renderAdminErrorPage(
      status === 404 ? 'Admin page not found' : 'Something went wrong',
      status === 404
        ? 'That page does not exist in the admin console.'
        : 'The admin console hit an unexpected problem. Reload and try again.',
      '/admin',
      'Back to the console',
    ));
    return;
  }
  res.status(status).type('html').send(renderErrorPage(
    status === 404 ? 'Not found.' : 'Something went wrong.',
    status === 404 ? 'That page does not exist.' : 'Please try that again in a moment.',
  ));
});

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function renderBars(peaks, code) {
  const values = peaks && peaks.length ? peaks : fallbackPeaks(code);
  return values
    .map((value) => {
      const height = Math.max(8, Math.min(100, Math.round(value * 100)));
      return `<span style="--h:${height}%"></span>`;
    })
    .join('');
}

function brandMark() {
  return `<span class="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>
    </svg>
  </span>`;
}

function renderPlayPage(meta, req) {
  const title = escapeHtml(meta.title);
  const code = encodeURIComponent(meta.code);
  const recordedOn = formatDate(meta.createdAt);
  const durationLabel = meta.duration ? formatDuration(meta.duration) : 'Voice note';
  const expiry = meta.expiresAt
    ? `Available until ${formatDate(meta.expiresAt)}`
    : 'Saved on this EchoTag server';
  const shareUrl = `${defaultBaseFor(req)}/p/${meta.code}`;
  const mediaSrc = meta.audioUrl ? escapeHtml(meta.audioUrl) : `/media/${code}`;
  const autoplay = Boolean(meta.autoplay);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title} · ${APP_NAME}</title>
  <meta name="description" content="A voice note, ready to play. Scanned with ${APP_NAME}.">
  <meta name="theme-color" content="#08080d">
  <meta property="og:title" content="${title} · ${APP_NAME}">
  <meta property="og:description" content="A voice note, ready to play.">
  <meta property="og:type" content="music.other">
  <meta property="og:url" content="${escapeHtml(shareUrl)}">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/play.css">
</head>
<body data-autoplay="${autoplay ? '1' : '0'}" data-duration="${Number(meta.duration) || 0}">
  <div class="aurora" aria-hidden="true">
    <span class="aurora-blob blob-a"></span>
    <span class="aurora-blob blob-b"></span>
    <span class="aurora-blob blob-c"></span>
  </div>

  <main class="shell">
    <header class="play-header">
      <a class="brand" href="/">${brandMark()}<span>${APP_NAME}</span></a>
      <span class="header-note">Scanned voice note</span>
    </header>

    <article class="note-card" id="noteCard">
      <div class="note-art" aria-hidden="true">
        <div class="orb">
          <span class="orb-ring ring-a"></span>
          <span class="orb-ring ring-b"></span>
          <svg class="orb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3"/>
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>
          </svg>
        </div>
        <div class="art-bars">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
      </div>

      <div class="note-body">
        <p class="eyebrow"><span class="eyebrow-dot"></span> Voice note</p>
        <h1 class="note-title">${title}</h1>
        <p class="note-meta">${escapeHtml(recordedOn)}${meta.duration ? ` · ${escapeHtml(durationLabel)}` : ''}</p>

        <div class="wave" id="wave" role="presentation">${renderBars(meta.peaks, meta.code)}</div>
        <input class="seek" id="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek through the recording">

        <div class="control-row">
          <button class="play-button" id="playBtn" type="button" aria-label="Play voice note">
            <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>
            <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4.4" height="15" rx="1.2"/><rect x="13.6" y="4.5" width="4.4" height="15" rx="1.2"/></svg>
          </button>

          <div class="play-status" aria-live="polite">
            <span class="times"><span id="currentTime">0:00</span> / <span id="totalTime">${escapeHtml(durationLabel)}</span></span>
            <span class="status-line" id="statusLine">${autoplay ? 'Tap to play' : 'Ready when you are'}</span>
          </div>
        </div>

        <p class="hint" id="hint">${autoplay ? 'Trying to play automatically…' : 'Tap the play button to listen.'}</p>
        <p class="expiry">${escapeHtml(expiry)}</p>
      </div>
    </article>

    <footer class="play-footer">
      <p>Have something to say?</p>
      <a class="cta" href="/">
        <span>Record your own</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>
    </footer>
    <p class="play-copyright">© Sinsana Studio 2026 · All rights reserved.</p>

    <noscript>
      <p class="noscript">JavaScript is off, but you can still listen below.</p>
      <audio controls src="${mediaSrc}"></audio>
    </noscript>
  </main>

  <audio id="audio" src="${mediaSrc}" preload="auto"></audio>
  <script src="/play.js" defer></script>
</body>
</html>`;
}

function renderErrorPage(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ${APP_NAME}</title>
  <meta name="theme-color" content="#08080d">
  <meta name="robots" content="noindex">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/play.css">
</head>
<body class="error-page">
  <div class="aurora" aria-hidden="true">
    <span class="aurora-blob blob-a"></span>
    <span class="aurora-blob blob-b"></span>
  </div>
  <main class="error-shell">
    <a class="brand" href="/">${brandMark()}<span>${APP_NAME}</span></a>
    <div class="error-card">
      <div class="error-orb" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" opacity=".35"/>
          <path d="m9 9 6 6M15 9l-6 6"/>
        </svg>
      </div>
      <p class="eyebrow">Nothing to play</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="error-copy">${escapeHtml(message)}</p>
      <a class="cta" href="/">
        <span>Record a voice note</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>
    </div>
    <p class="error-copyright">© Sinsana Studio 2026 · All rights reserved.</p>
  </main>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Admin views                                                        */
/* ------------------------------------------------------------------ */

function formatDateTime(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

function renderAdminErrorPage(title, message, backHref = '/admin', backLabel = 'Back to the console') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)} · ${APP_NAME} admin</title>
  <meta name="theme-color" content="#08080d">
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <div class="admin-aurora" aria-hidden="true"><span></span><span></span></div>
  <main class="login-shell">
    <header class="admin-header">
      <a class="brand" href="/">${brandMark()}<span>${APP_NAME}</span></a>
      <span class="header-note">Private console</span>
    </header>
    <section class="login-card admin-error-card">
      <div class="login-orb login-orb-error" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <path d="M12 8v5M12 16h.01"/>
          <path d="M10.3 3.8 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/>
        </svg>
      </div>
      <p class="eyebrow">Admin console</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="login-copy">${escapeHtml(message)}</p>
      <a class="button ghost" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>
    </section>
    <footer class="admin-footer">
      <p>© Sinsana Studio 2026 · All rights reserved.</p>
      <p><a href="/">EchoTag home</a></p>
    </footer>
  </main>
</body>
</html>`;
}

function renderAdminLoginPage({ csrf, error }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Sign in · ${APP_NAME} admin</title>
  <meta name="description" content="Private EchoTag admin console.">
  <meta name="theme-color" content="#08080d">
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <div class="admin-aurora" aria-hidden="true"><span></span><span></span></div>
  <main class="login-shell">
    <header class="admin-header">
      <a class="brand" href="/">${brandMark()}<span>${APP_NAME}</span></a>
      <span class="header-note">Private console</span>
    </header>

    <section class="login-card">
      <div class="login-orb" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3 4.5 6v5.4c0 4.5 3.1 7.7 7.5 9.6 4.4-1.9 7.5-5.1 7.5-9.6V6L12 3Z"/>
          <path d="m9 12 2 2 4-4"/>
        </svg>
      </div>
      <p class="eyebrow">Sinsana Studio · Admin</p>
      <h1>Welcome back.</h1>
      <p class="login-copy">Sign in to listen to and manage every voice note stored on this server.</p>

      ${error ? `<p class="alert alert-error" role="alert">${escapeHtml(error)}</p>` : ''}

      <form class="login-form" method="post" action="/admin/login">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <label class="field">
          <span>Username</span>
          <input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="80" required autofocus>
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" maxlength="256" required>
        </label>
        <button class="button primary" type="submit">Sign in</button>
      </form>

      <p class="login-foot">Authorized users only. Sessions expire after 8 hours, and repeated failures are rate-limited.</p>
    </section>

    <footer class="admin-footer">
      <p>© Sinsana Studio 2026 · All rights reserved.</p>
      <p><a href="/">Back to EchoTag</a></p>
    </footer>
  </main>
</body>
</html>`;
}

function renderAdminRecordingRow(meta, csrf) {
  const code = String(meta.code);
  const title = meta.title || 'Voice note';
  const expired = Boolean(meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now());
  const duration = meta.duration ? formatDuration(meta.duration) : '—';
  const size = formatBytes(meta.size);
  const created = formatDateTime(meta.createdAt);
  const expiry = meta.expiresAt
    ? `${expired ? 'Expired' : 'Expires'} ${formatDate(meta.expiresAt)}`
    : 'No expiry';
  const search = escapeHtml(`${title} ${code}`.toLowerCase());
  const confirmText = `Delete &quot;${escapeHtml(title)}&quot;? This permanently removes the audio and cannot be undone.`;

  return `<article class="recording" data-search="${search}">
    <div class="recording-main">
      <div class="recording-top">
        <h3 class="recording-title">${escapeHtml(title)}</h3>
        <span class="badge ${expired ? 'badge-expired' : 'badge-active'}">${expired ? 'Expired' : 'Active'}</span>
      </div>
      <p class="recording-meta">
        <span class="code-pill">${escapeHtml(code)}</span>
        <span>${escapeHtml(created)}</span>
        <span>${escapeHtml(duration)}</span>
        <span>${escapeHtml(size)}</span>
        <span>${escapeHtml(expiry)}</span>
      </p>
      <audio controls preload="none" src="/admin/audio/${encodeURIComponent(code)}"></audio>
    </div>
    <div class="recording-actions">
      <a class="button ghost small" href="/p/${encodeURIComponent(code)}" target="_blank" rel="noopener">Open player</a>
      <form method="post" action="/admin/recordings/${encodeURIComponent(code)}/delete" data-confirm="${confirmText}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <button class="button danger small" type="submit">Delete</button>
      </form>
    </div>
  </article>`;
}

function renderAdminDashboard({ recordings, csrf, status, listError, storageLabel }) {
  const now = Date.now();
  const active = recordings.filter((meta) => !(meta.expiresAt && Date.parse(meta.expiresAt) <= now)).length;
  const totalBytes = recordings.reduce((sum, meta) => sum + (Number(meta.size) || 0), 0);
  const totalDuration = recordings.reduce((sum, meta) => sum + (Number(meta.duration) || 0), 0);
  const rows = recordings.map((meta) => renderAdminRecordingRow(meta, csrf)).join('');

  const statusMessages = {
    deleted: 'The recording was deleted.',
    missing: 'That recording was already gone.',
    error: 'The recording could not be deleted. Please try again.',
  };
  const statusHtml = status && statusMessages[status]
    ? `<p class="alert ${status === 'deleted' ? 'alert-ok' : 'alert-warn'}" role="status">${escapeHtml(statusMessages[status])}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Recordings · ${APP_NAME} admin</title>
  <meta name="description" content="Private EchoTag admin console.">
  <meta name="theme-color" content="#08080d">
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <div class="admin-aurora" aria-hidden="true"><span></span><span></span></div>
  <header class="admin-header admin-header-wide">
    <a class="brand" href="/">${brandMark()}<span>${APP_NAME}</span></a>
    <div class="admin-header-actions">
      <span class="header-note">Private console</span>
      <a class="button ghost small" href="/admin/dashboard">Refresh</a>
      <form class="inline-form" method="post" action="/admin/logout">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <button class="button ghost small" type="submit">Sign out</button>
      </form>
    </div>
  </header>

  <main class="admin-shell">
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Admin console</p>
      <h1>Every voice note.</h1>
      <p class="hero-copy">Listen to any recording stored on this server, or remove it permanently. Storage: <strong>${escapeHtml(storageLabel)}</strong>.</p>
      <div class="stats">
        <div class="stat"><span>Total notes</span><strong>${recordings.length}</strong></div>
        <div class="stat"><span>Active</span><strong>${active}</strong></div>
        <div class="stat"><span>Audio</span><strong>${escapeHtml(formatBytes(totalBytes))}</strong></div>
        <div class="stat"><span>Play time</span><strong>${escapeHtml(formatDuration(totalDuration))}</strong></div>
      </div>
    </section>

    ${statusHtml}
    ${listError ? `<p class="alert alert-warn" role="alert">${escapeHtml(listError)}</p>` : ''}

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Recordings</h2>
          <p id="visibleCount" data-total="${recordings.length}">${recordings.length} ${recordings.length === 1 ? 'note' : 'notes'}</p>
        </div>
        <label class="search">
          <span class="sr-only">Search recordings</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="adminSearch" type="search" placeholder="Search title or code" autocomplete="off">
        </label>
      </div>

      <div class="recording-list" id="recordingList">
        ${rows || `<div class="empty-state">
          <div class="empty-orb" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v10M8 7v4M16 7v4M5 13a7 7 0 0 0 14 0M12 20v1"/></svg>
          </div>
          <h3>No recordings yet</h3>
          <p>New voice notes will appear here as soon as someone records one.</p>
          <a class="button ghost small" href="/">Open the recorder</a>
        </div>`}
      </div>
    </section>

    <footer class="admin-footer">
      <p>© Sinsana Studio 2026 · All rights reserved.</p>
      <p><a href="/">EchoTag home</a></p>
    </footer>
  </main>
  <script src="/admin.js" defer></script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

module.exports = app;

if (require.main === module) {
  startLocalServer();
}

function startLocalServer() {
  const server = app.listen(PORT, '0.0.0.0');

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  ${APP_NAME} could not start: port ${PORT} is already in use.`);
      console.error(`  Another copy may already be running at http://localhost:${PORT}.`);
      console.error(`  Stop that copy, or choose another port with the PORT environment variable.`);
      console.error('');
    } else {
      console.error(`${APP_NAME} could not start:`, err);
    }
    process.exit(1);
  });

  server.once('listening', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      console.error(`${APP_NAME} could not determine its listening port.`);
      process.exit(1);
    }

    activePort = address.port;
    const lanIp = pickLanIp();
    console.log('');
    console.log(`  ${APP_NAME} is running`);
    console.log(`  Local:    http://localhost:${activePort}`);
    if (lanIp) console.log(`  Network:  http://${lanIp}:${activePort}  <- use this address on your phone`);
    const storageLabel = STORAGE_MODE === 'blob'
      ? 'Vercel Blob'
      : STORAGE_MODE === 'unavailable'
        ? 'not configured (Blob store missing)'
        : path.relative(APP_URL_PATH, DATA_DIR);
    console.log(`  Storage:  ${storageLabel}`);
    console.log(`  Retain:   ${RETENTION_DAYS > 0 ? `${RETENTION_DAYS} days` : 'until deleted'}`);
    if (ADMIN_CONFIGURED) {
      console.log(`  Admin:    http://localhost:${activePort}/admin`);
    } else {
      console.log(`  Admin:    disabled (${ADMIN_CONFIG_ISSUE})`);
    }
    console.log('');
  });

  sweepExpired().catch((err) => console.warn('Expiry sweep failed:', err.message));
  const sweepTimer = setInterval(() => {
    sweepExpired().catch((err) => console.warn('Expiry sweep failed:', err.message));
  }, 6 * 60 * 60 * 1000);
  sweepTimer.unref();
}
