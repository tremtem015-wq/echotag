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
const net = require('node:net');
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
const STUDENT_COOKIE = 'echotag_student';
const STUDENT_SESSION_VERSION = 'v1';
const STUDENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STUDENT_LOGIN_LIMIT = 40;
const STUDENT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const STUDENT_SESSION_SECRET = ADMIN_SESSION_SECRET
  || crypto.randomBytes(32).toString('base64url');
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const DATA_DIR = path.join(__dirname, 'data', 'recordings');
const STATE_DIR = path.join(__dirname, 'data', 'state');
const ACTIVITY_DIR = path.join(__dirname, 'data', 'activity');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = ON_VERCEL ? path.join(process.cwd(), 'views') : path.join(__dirname, 'views');
const APP_URL_PATH = __dirname;
const BLOB_META_PREFIX = 'echotag/meta/';
const BLOB_AUDIO_PREFIX = 'echotag/audio/';
const BLOB_STATE_PREFIX = 'echotag/state/';
const BLOB_ACTIVITY_PREFIX = 'echotag/activity/';
const STATE_CACHE_TTL_MS = 5_000;
const PRESENCE_TTL_MS = 2 * 60 * 1000;
const PRESENCE_LOG_INTERVAL_MS = 30 * 60 * 1000;
const ACTIVITY_LIMIT = 400;
const BOARD_LIMIT = 50;
const BOARD_TITLE_MAX = 120;
const BOARD_BODY_MAX = 4000;
const BOARD_POST_ID = /^[A-Za-z0-9_-]{8,32}$/;
const GRADE_LEVELS = Object.freeze(['M2', 'G8']);
const NUMBER_MIN = 1;
const NUMBER_MAX = 34;

if (STORAGE_MODE === 'file') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
}

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

/* ------------------------------------------------------------------ */
/* Identity, quality, and moderation helpers                           */
/* ------------------------------------------------------------------ */

function cleanStudentName(raw) {
  const value = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  if (value.length < 2) return { error: 'Enter the student’s full name.' };
  if (!/\p{L}/u.test(value)) return { error: 'Enter a name that contains letters.' };
  if (!/^[\p{L}\p{M} .'’\-]+$/u.test(value)) {
    return { error: 'Use letters, spaces, hyphens, apostrophes, or periods only.' };
  }
  return { value };
}

function cleanStudentId(raw) {
  const value = String(raw || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^0+(?=\d)/, '');

  if (!/^(?:[1-9]|[1-2][0-9]|3[0-4])$/.test(value)) {
    return { error: `Select a number from ${NUMBER_MIN} to ${NUMBER_MAX}.` };
  }
  return { value };
}

function readStudentInput(body) {
  const name = cleanStudentName(body && body.studentName);
  const id = cleanStudentId(body && body.studentId);
  const grade = String((body && body.grade) || '').trim().toUpperCase();
  const errors = [];
  if (name.error) errors.push(name.error);
  if (id.error) errors.push(id.error);
  if (!GRADE_LEVELS.includes(grade)) errors.push('Select a valid grade level.');

  return {
    ok: errors.length === 0,
    errors,
    student: errors.length === 0
      ? { name: name.value, id: id.value, grade }
      : null,
  };
}

function roundMetric(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function parseQualityStats(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      averageLevel: clampNumber(Number(parsed.averageLevel), 0, 1, 0),
      peakLevel: clampNumber(Number(parsed.peakLevel), 0, 1, 0),
      silenceRatio: clampNumber(Number(parsed.silenceRatio), 0, 1, 0),
      clippingRatio: clampNumber(Number(parsed.clippingRatio), 0, 1, 0),
      samples: Math.round(clampNumber(Number(parsed.samples), 0, 100000, 0)),
    };
  } catch {
    return null;
  }
}

function analyzeAudioQuality({ duration, peaks, stats }) {
  const values = Array.isArray(peaks) ? peaks : [];
  const averagePeak = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
  const quietRatio = values.length
    ? values.filter((value) => value < 0.12).length / values.length
    : 1;
  const hasStats = Boolean(stats && stats.samples >= 5);
  const silenceRatio = hasStats ? stats.silenceRatio : quietRatio;
  const averageLevel = hasStats ? stats.averageLevel : 0;
  const clippingRatio = hasStats ? stats.clippingRatio : 0;

  let penalty = 0;
  const reasons = [];

  if (!duration || duration < 1.2) {
    penalty += 40;
    reasons.push('Very short clip');
  } else if (duration < 2) {
    penalty += 22;
    reasons.push('Short clip');
  } else if (duration < 3) {
    penalty += 8;
    reasons.push('Quite short');
  }

  if (silenceRatio > 0.72) {
    penalty += 32;
    reasons.push('Mostly silence');
  } else if (silenceRatio > 0.55) {
    penalty += 16;
    reasons.push('Long silent gaps');
  }

  if (averagePeak < 0.16) {
    penalty += 22;
    reasons.push('Very low signal');
  } else if (averagePeak < 0.28) {
    penalty += 10;
    reasons.push('Low signal');
  }

  if (hasStats && averageLevel > 0 && averageLevel < 0.0025) {
    penalty += 12;
    reasons.push('Very quiet microphone');
  }

  if (clippingRatio > 0.06) {
    penalty += 18;
    reasons.push('Heavy clipping');
  } else if (clippingRatio > 0.015) {
    penalty += 7;
    reasons.push('Possible clipping');
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const label = score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor';

  return {
    score,
    label,
    reasons: [...new Set(reasons)],
    reviewRequired: score < 60,
    metrics: {
      averagePeak: roundMetric(averagePeak),
      quietRatio: roundMetric(quietRatio),
      silenceRatio: roundMetric(silenceRatio),
      averageLevel: roundMetric(averageLevel, 4),
      clippingRatio: roundMetric(clippingRatio, 4),
      samples: hasStats ? stats.samples : 0,
    },
    analyzedAt: new Date().toISOString(),
  };
}

function moderationFor(meta) {
  const source = meta && meta.moderation && typeof meta.moderation === 'object'
    ? meta.moderation
    : {};
  const status = ['pending', 'approved', 'hidden', 'flagged'].includes(source.status)
    ? source.status
    : 'pending';
  return {
    status,
    quality: source.quality && typeof source.quality === 'object' ? source.quality : null,
    note: typeof source.note === 'string' ? source.note : '',
    reviewedAt: typeof source.reviewedAt === 'string' ? source.reviewedAt : '',
    reviewedBy: typeof source.reviewedBy === 'string' ? source.reviewedBy : '',
  };
}

function isPubliclyVisible(meta) {
  const status = moderationFor(meta).status;
  return status !== 'hidden' && status !== 'flagged';
}

function recordingStudent(meta) {
  if (!meta || !meta.student) return null;
  const decoded = decryptJsonValue(meta.student);
  if (!decoded || typeof decoded !== 'object') return null;
  const name = typeof decoded.name === 'string' ? decoded.name : '';
  const id = typeof decoded.id === 'string' ? decoded.id : '';
  const grade = typeof decoded.grade === 'string' ? decoded.grade : '';
  if (!name && !id && !grade) return null;
  return { name, id, grade };
}

const MODERATION_LABELS = Object.freeze({
  pending: 'Pending review',
  approved: 'Approved',
  hidden: 'Hidden',
  flagged: 'Flagged',
});

/* ------------------------------------------------------------------ */
/* Encrypted state + activity storage                                  */
/* ------------------------------------------------------------------ */

const STATE_ENCRYPTION_KEY = (() => {
  if (!ADMIN_SESSION_SECRET) return null;
  try {
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      Buffer.from(ADMIN_SESSION_SECRET, 'utf8'),
      Buffer.from('echotag', 'utf8'),
      Buffer.from('state-v1', 'utf8'),
      32,
    ));
  } catch {
    return crypto.createHash('sha256').update(`echotag-state:${ADMIN_SESSION_SECRET}`).digest();
  }
})();

function encryptJsonValue(value) {
  if (!STATE_ENCRYPTION_KEY) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', STATE_ENCRYPTION_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url'),
  };
}

function decryptJsonValue(value) {
  if (!value || typeof value !== 'object' || value.v !== 1
    || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.data !== 'string') {
    return value;
  }
  if (!STATE_ENCRYPTION_KEY) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      STATE_ENCRYPTION_KEY,
      Buffer.from(value.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

function encodeStoredDocument(value) {
  const encrypted = encryptJsonValue(value);
  return JSON.stringify(STATE_ENCRYPTION_KEY
    ? { enc: 'echotag-state-v1', payload: encrypted }
    : value);
}

function decodeStoredDocument(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enc === 'echotag-state-v1') {
      return decryptJsonValue(parsed.payload) ?? fallback;
    }
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

const stateCache = new Map();

// Public Blob URLs can keep serving the previous bytes after an overwrite, so
// every metadata/state write gets a unique immutable pathname instead.
function blobVersionSuffix() {
  return `${String(Date.now()).padStart(13, '0')}-${crypto.randomBytes(6).toString('hex')}`;
}

async function listAllBlobs(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: BLOB_TOKEN });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function newestBlobFirst(a, b) {
  const delta = (new Date(b.uploadedAt).getTime() || 0) - (new Date(a.uploadedAt).getTime() || 0);
  if (delta !== 0) return delta;
  return String(b.pathname).localeCompare(String(a.pathname));
}

async function readStateDocument(name, fallback, { force = false } = {}) {
  const cached = stateCache.get(name);
  if (!force && cached && Date.now() - cached.at < STATE_CACHE_TTL_MS) {
    return cached.value;
  }

  let raw = null;
  if (STORAGE_MODE === 'blob') {
    try {
      const versions = (await listAllBlobs(`${BLOB_STATE_PREFIX}${name}.`)).sort(newestBlobFirst);
      for (const blob of versions) {
        const response = await fetch(blob.url, { cache: 'no-store' });
        if (!response.ok) continue;
        raw = await response.text();
        break;
      }
    } catch (err) {
      if (!isBlobMissing(err)) console.warn(`State read warning (${name}):`, err.message);
    }
  } else if (STORAGE_MODE === 'file') {
    try {
      raw = await fsp.readFile(path.join(STATE_DIR, `${name}.json`), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`State read warning (${name}):`, err.message);
    }
  }

  const value = raw ? decodeStoredDocument(raw, fallback) : fallback;
  stateCache.set(name, { at: Date.now(), value });
  return value;
}

async function pruneStateVersions(name) {
  try {
    const versions = (await listAllBlobs(`${BLOB_STATE_PREFIX}${name}.`)).sort(newestBlobFirst);
    const stale = versions.slice(8).map((blob) => blob.pathname);
    if (stale.length) await del(stale, { token: BLOB_TOKEN });
  } catch (err) {
    if (!isBlobMissing(err)) console.warn(`State prune warning (${name}):`, err.message);
  }
}

async function writeStateDocument(name, value) {
  if (STORAGE_MODE === 'unavailable') throw httpError(503, 'Storage is not connected.');

  const raw = encodeStoredDocument(value);
  if (STORAGE_MODE === 'blob') {
    await put(`${BLOB_STATE_PREFIX}${name}.${blobVersionSuffix()}.json`, raw, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      token: BLOB_TOKEN,
    });
    await pruneStateVersions(name);
  } else {
    const target = path.join(STATE_DIR, `${name}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temp, raw);
    await fsp.rename(temp, target);
  }
  stateCache.set(name, { at: Date.now(), value });
}

function invalidateState(name) {
  stateCache.delete(name);
}

function activityFileStem() {
  return `${String(9_999_999_999_999 - Date.now()).padStart(13, '0')}-${crypto.randomBytes(8).toString('hex')}`;
}

async function logActivity(event) {
  if (STORAGE_MODE === 'unavailable') return;
  const entry = {
    id: crypto.randomBytes(9).toString('base64url'),
    at: new Date().toISOString(),
    ...event,
  };
  const raw = encodeStoredDocument(entry);
  const stem = activityFileStem();

  if (STORAGE_MODE === 'blob') {
    await put(`${BLOB_ACTIVITY_PREFIX}${stem}.json`, raw, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      token: BLOB_TOKEN,
    });
    return;
  }

  await fsp.writeFile(path.join(ACTIVITY_DIR, `${stem}.json`), raw);
}

async function listActivityEntries(limit = ACTIVITY_LIMIT) {
  const names = [];
  if (STORAGE_MODE === 'blob') {
    try {
      const page = await list({
        prefix: BLOB_ACTIVITY_PREFIX,
        limit,
        token: BLOB_TOKEN,
      });
      for (const blob of page.blobs) {
        if (blob.pathname.endsWith('.json')) names.push(blob);
      }
    } catch (err) {
      console.warn('Activity list warning:', err.message);
      return [];
    }
  } else if (STORAGE_MODE === 'file') {
    try {
      const files = (await fsp.readdir(ACTIVITY_DIR))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .slice(0, limit);
      for (const name of files) names.push({ pathname: name });
    } catch {
      return [];
    }
  } else {
    return [];
  }

  const entries = [];
  for (let index = 0; index < names.length; index += 10) {
    const batch = names.slice(index, index + 10);
    const results = await Promise.allSettled(batch.map(async (blob) => {
      let raw;
      if (STORAGE_MODE === 'blob') {
        const response = await fetch(blob.url, { cache: 'no-store' });
        if (!response.ok) return null;
        raw = await response.text();
      } else {
        raw = await fsp.readFile(path.join(ACTIVITY_DIR, blob.pathname), 'utf8');
      }
      const entry = decodeStoredDocument(raw, null);
      return entry && typeof entry.at === 'string' ? entry : null;
    }));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) entries.push(result.value);
    }
  }

  return entries
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* IP blocks + presence                                                */
/* ------------------------------------------------------------------ */

function normalizeIp(raw) {
  let value = String(raw || '').trim();
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (!net.isIP(value)) return '';
  return value.toLowerCase();
}

function clientIp(req) {
  return normalizeIp(req.ip) || 'unknown';
}

function cleanBlockReason(raw) {
  const value = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (value.length < 3) return { error: 'Enter a reason with at least 3 characters.' };
  return { value };
}

async function readBlocks({ force = false } = {}) {
  const doc = await readStateDocument('ip-blocks', { blocks: [] }, { force });
  return Array.isArray(doc.blocks)
    ? doc.blocks.filter((block) => block && normalizeIp(block.ip))
    : [];
}

async function findBlockForIp(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;
  // Public gates must never consult a per-instance cache: an administrator's
  // block or unblock has to apply on the very next request, on every instance.
  const blocks = await readBlocks({ force: true });
  return blocks.find((block) => normalizeIp(block.ip) === normalized) || null;
}

async function addIpBlock({ ip, reason, blockedBy }) {
  const normalized = normalizeIp(ip);
  if (!normalized) throw httpError(400, 'Enter a valid IPv4 or IPv6 address.');
  const cleanReason = cleanBlockReason(reason);
  if (cleanReason.error) throw httpError(400, cleanReason.error);

  const doc = await readStateDocument('ip-blocks', { blocks: [] }, { force: true });
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  if (blocks.some((block) => normalizeIp(block.ip) === normalized)) {
    throw httpError(409, 'That IP address is already blocked.');
  }

  const record = {
    ip: normalized,
    reason: cleanReason.value,
    blockedBy: String(blockedBy || 'administrator').slice(0, 80),
    blockedAt: new Date().toISOString(),
  };
  await writeStateDocument('ip-blocks', { blocks: [...blocks, record] });
  return record;
}

async function removeIpBlock(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) throw httpError(400, 'Enter a valid IPv4 or IPv6 address.');
  const doc = await readStateDocument('ip-blocks', { blocks: [] }, { force: true });
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const record = blocks.find((block) => normalizeIp(block.ip) === normalized);
  if (!record) return null;
  await writeStateDocument('ip-blocks', {
    blocks: blocks.filter((block) => normalizeIp(block.ip) !== normalized),
  });
  return record;
}

/* ------------------------------------------------------------------ */
/* Bulletin board                                                      */
/* ------------------------------------------------------------------ */

function cleanBoardTitle(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BOARD_TITLE_MAX);
}

function cleanBoardBody(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, BOARD_BODY_MAX);
}

function readBoardInput(body) {
  const title = cleanBoardTitle(body && body.title);
  const text = cleanBoardBody(body && body.body);
  const errors = [];
  if (title.length < 2) errors.push('Enter a bulletin title.');
  if (text.length < 2) errors.push('Enter a bulletin message.');
  return {
    ok: errors.length === 0,
    errors,
    post: errors.length === 0 ? { title, body: text } : null,
  };
}

function normalizeBoardPosts(doc) {
  const posts = Array.isArray(doc && doc.posts) ? doc.posts : [];
  return posts
    .filter((post) => post
      && BOARD_POST_ID.test(String(post.id))
      && typeof post.title === 'string'
      && typeof post.body === 'string')
    .map((post) => ({
      id: String(post.id),
      title: post.title.slice(0, BOARD_TITLE_MAX),
      body: post.body.slice(0, BOARD_BODY_MAX),
      author: typeof post.author === 'string' ? post.author.slice(0, 80) : 'Administrator',
      createdAt: typeof post.createdAt === 'string' ? post.createdAt : '',
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function listBoardPosts({ force = false } = {}) {
  const doc = await readStateDocument('board', { posts: [] }, { force });
  return normalizeBoardPosts(doc).slice(0, BOARD_LIMIT);
}

async function addBoardPost({ title, body, author }) {
  const existing = await listBoardPosts({ force: true });
  const post = {
    id: crypto.randomBytes(9).toString('base64url'),
    title,
    body,
    author: String(author || 'Administrator').slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  await writeStateDocument('board', { posts: [post, ...existing].slice(0, BOARD_LIMIT) });
  return post;
}

async function removeBoardPost(id) {
  if (!BOARD_POST_ID.test(String(id || ''))) return null;
  const existing = await listBoardPosts({ force: true });
  const removed = existing.find((post) => post.id === id);
  if (!removed) return null;
  await writeStateDocument('board', { posts: existing.filter((post) => post.id !== id) });
  return removed;
}

function blockedApiResponse(res, block) {
  res.set('Cache-Control', 'no-store');
  res.status(403).json({
    error: `An administrator has blocked this IP address. Reason: ${block.reason}`,
    blocked: true,
    reason: block.reason,
    blockedAt: block.blockedAt,
  });
}

async function publicApiBlockGate(req, res, next) {
  try {
    const block = await findBlockForIp(clientIp(req));
    if (block) {
      blockedApiResponse(res, block);
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function publicPageBlockGate(req, res, next) {
  try {
    const block = await findBlockForIp(clientIp(req));
    if (block) {
      res.set({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.status(403).type('html').send(renderBlockedPage(block));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function publicMediaBlockGate(req, res, next) {
  try {
    const block = await findBlockForIp(clientIp(req));
    if (block) {
      res.set('Cache-Control', 'no-store');
      res.status(403).type('text/plain').send('An administrator has blocked this IP address.');
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

const presenceRecords = new Map();

function prunePresence(now = Date.now()) {
  for (const [ip, record] of presenceRecords) {
    if (now - record.lastSeen > PRESENCE_TTL_MS) presenceRecords.delete(ip);
  }
}

function touchPresence(req, { page, code, student } = {}) {
  const ip = clientIp(req);
  if (ip === 'unknown') return null;

  const now = Date.now();
  prunePresence(now);
  let record = presenceRecords.get(ip);
  if (!record) {
    record = {
      ip,
      firstSeen: now,
      lastSeen: now,
      hits: 0,
      page: 'recorder',
      code: '',
      userAgent: '',
      visitLoggedAt: 0,
      student: null,
    };
    presenceRecords.set(ip, record);
  }

  record.lastSeen = now;
  record.hits += 1;
  if (page) record.page = page;
  if (code) record.code = code;
  record.userAgent = String(req.get('user-agent') || '').slice(0, 180);
  if (student) {
    record.student = student;
    record.studentAt = now;
  }
  return record;
}

function listPresence() {
  const now = Date.now();
  prunePresence(now);
  return [...presenceRecords.values()]
    .map((record) => ({
      ...record,
      active: now - record.lastSeen <= PRESENCE_TTL_MS,
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

function presenceForIp(ip) {
  return presenceRecords.get(normalizeIp(ip) || ip) || null;
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

function blobMetaVersionPathname(code) {
  return `${BLOB_META_PREFIX}${code}.${blobVersionSuffix()}.json`;
}

function metaCodeFromPathname(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith(BLOB_META_PREFIX) || !value.endsWith('.json')) return null;
  const stem = value.slice(BLOB_META_PREFIX.length, -'.json'.length);
  const code = stem.split('.')[0];
  return CODE_PATTERN.test(code) ? code : null;
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

async function latestMetaBlobs() {
  const latest = new Map();
  for (const blob of await listAllBlobs(BLOB_META_PREFIX)) {
    const code = metaCodeFromPathname(blob.pathname);
    if (!code) continue;
    const current = latest.get(code);
    if (!current || newestBlobFirst(blob, current) < 0) latest.set(code, blob);
  }
  return latest;
}

async function readMetaFromBlob(code) {
  let versions;
  try {
    versions = (await listAllBlobs(`${BLOB_META_PREFIX}${code}.`))
      .filter((blob) => metaCodeFromPathname(blob.pathname) === code)
      .sort(newestBlobFirst);
  } catch (err) {
    if (isBlobMissing(err)) return null;
    throw err;
  }

  for (const blob of versions) {
    try {
      const response = await fetch(blob.url, { cache: 'no-store' });
      if (!response.ok) continue;
      const meta = parseMeta(await response.json(), code);
      if (meta) return meta;
    } catch {
      // Try the next version; an unreadable sidecar must not block playback.
    }
  }
  return null;
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
  const latest = [...(await latestMetaBlobs()).values()];

  for (let index = 0; index < latest.length; index += 8) {
    const batch = latest.slice(index, index + 8);
    const results = await Promise.allSettled(batch.map(async (blob) => {
      const code = metaCodeFromPathname(blob.pathname);
      if (!code) return null;
      const response = await fetch(blob.url, { cache: 'no-store' });
      if (!response.ok) return null;
      return parseMeta(await response.json(), code);
    }));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) recordings.push(result.value);
    }
  }

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
  if (STORAGE_MODE === 'blob') {
    await put(blobMetaVersionPathname(meta.code), JSON.stringify(meta, null, 2), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      token: BLOB_TOKEN,
    });
    return;
  }

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
      await writeMeta(meta);
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
      const versions = (await listAllBlobs(`${BLOB_META_PREFIX}${meta.code}.`))
        .filter((blob) => metaCodeFromPathname(blob.pathname) === meta.code)
        .map((blob) => blob.pathname);
      if (versions.length) await del(versions, { token: BLOB_TOKEN });
    } catch (err) {
      if (!isBlobMissing(err)) console.warn(`Cleanup warning for ${meta.code}:`, err.message);
    }

    try {
      await del(blobAudioPathname(meta), { token: BLOB_TOKEN });
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
      const existing = await list({
        prefix: `${BLOB_META_PREFIX}${code}.`,
        limit: 1,
        token: BLOB_TOKEN,
      });
      if (!existing.blobs.length) return code;
      continue;
    }

    if (!fs.existsSync(path.join(DATA_DIR, `${code}.json`))) return code;
  }
  throw httpError(503, 'Could not allocate a link. Please try again.');
}

async function sweepExpired() {
  if (STORAGE_MODE === 'unavailable') return;

  if (STORAGE_MODE === 'blob') {
    const latest = [...(await latestMetaBlobs()).values()];
    const now = Date.now();
    for (const blob of latest) {
      try {
        const code = metaCodeFromPathname(blob.pathname);
        if (!code) continue;
        const response = await fetch(blob.url, { cache: 'no-store' });
        if (!response.ok) continue;
        const meta = parseMeta(await response.json(), code);
        if (!meta || !meta.expiresAt) continue;
        if (Date.parse(meta.expiresAt) <= now) await removeRecording(meta);
      } catch {
        // Ignore unreadable sidecars; they are harmless.
      }
    }
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

function buildAdminAccount(username, hash, source, extra = {}) {
  const name = String(username || '').trim();
  const value = String(hash || '').trim();
  if (!isUsableAdminUsername(name) || !parsePasswordHash(value)) return null;
  return {
    username: name,
    hash: value,
    fingerprint: sha256(value).slice(0, 32),
    source,
    ...extra,
  };
}

const ENV_ADMIN_ACCOUNTS = (() => {
  const accounts = new Map();
  const add = (username, hash) => {
    const account = buildAdminAccount(username, hash, 'built-in');
    if (!account || accounts.has(account.username)) return false;
    accounts.set(account.username, account);
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
  if (ENV_ADMIN_ACCOUNTS.size === 0) {
    return 'No valid admin accounts are configured. Check ADMIN_USERNAME/ADMIN_PASSWORD_HASH and ADMIN_USERS.';
  }
  return null;
})();
const ADMIN_CONFIGURED = ADMIN_CONFIG_ISSUE === null;
// Used to spend the same scrypt time when a username does not exist.
const ADMIN_TIMING_HASH = ENV_ADMIN_ACCOUNTS.values().next().value?.hash || '';

let adminAccountCache = { at: 0, accounts: null };

async function loadAdminAccounts({ force = false } = {}) {
  if (!force && adminAccountCache.accounts && Date.now() - adminAccountCache.at < STATE_CACHE_TTL_MS) {
    return adminAccountCache.accounts;
  }

  const accounts = new Map(ENV_ADMIN_ACCOUNTS);
  try {
    const doc = await readStateDocument('admins', { admins: [] });
    const records = Array.isArray(doc.admins) ? doc.admins : [];
    for (const record of records) {
      const account = buildAdminAccount(
        record && record.username,
        record && record.passwordHash,
        'added',
        {
          createdAt: typeof record?.createdAt === 'string' ? record.createdAt : '',
          createdBy: typeof record?.createdBy === 'string' ? record.createdBy : '',
        },
      );
      if (account && !accounts.has(account.username)) accounts.set(account.username, account);
    }
  } catch (err) {
    console.warn('Dynamic admin load warning:', err.message);
  }

  adminAccountCache = { at: Date.now(), accounts };
  return accounts;
}

async function getAdminAccount(username, options) {
  const accounts = await loadAdminAccounts(options);
  return accounts.get(username);
}

function invalidateAdminAccounts() {
  adminAccountCache = { at: 0, accounts: null };
}

async function listAdminAccounts() {
  const accounts = await loadAdminAccounts({ force: true });
  return [...accounts.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'built-in' ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function validateNewAdmin({ username, password, confirmPassword }) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  const confirm = String(confirmPassword || '');
  const errors = [];

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(name)) {
    errors.push('Use 3–40 letters, numbers, dots, dashes, or underscores for the username.');
  }
  if (pass.length < 10) errors.push('The password must be at least 10 characters.');
  if (pass.length > 200) errors.push('The password is too long.');
  if (pass !== confirm) errors.push('The two passwords do not match.');

  return { ok: errors.length === 0, errors, username: name, password: pass };
}

async function addDynamicAdmin({ username, password, createdBy }) {
  const accounts = await loadAdminAccounts({ force: true });
  const lower = String(username).toLowerCase();
  if ([...accounts.keys()].some((name) => name.toLowerCase() === lower)) {
    throw httpError(409, 'An administrator with that username already exists.');
  }

  const doc = await readStateDocument('admins', { admins: [] }, { force: true });
  const records = Array.isArray(doc.admins) ? doc.admins : [];
  const passwordHash = await hashPassword(password);
  const record = {
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    createdBy: String(createdBy || 'administrator').slice(0, 80),
  };
  await writeStateDocument('admins', { admins: [...records, record] });
  invalidateAdminAccounts();
  return record;
}

async function removeDynamicAdmin(username) {
  const account = await getAdminAccount(username, { force: true });
  if (!account) throw httpError(404, 'That administrator does not exist.');
  if (account.source !== 'added') {
    throw httpError(403, 'Built-in administrators cannot be removed here.');
  }

  const doc = await readStateDocument('admins', { admins: [] }, { force: true });
  const records = Array.isArray(doc.admins) ? doc.admins : [];
  const next = records.filter((record) => record && record.username !== username);
  if (next.length === records.length) throw httpError(404, 'That administrator does not exist.');

  await writeStateDocument('admins', { admins: next });
  invalidateAdminAccounts();
  return account;
}

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

function buildCookie(req, name, value, maxAgeSeconds, path = '/', sameSite = 'Strict') {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
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

async function readAdminSession(req) {
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
  let account;
  try {
    account = await getAdminAccount(payload.u);
  } catch (err) {
    console.warn('Admin session account lookup failed:', err.message);
    return null;
  }
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

async function requireAdminSession(req, res, next) {
  try {
    const session = await readAdminSession(req);
    if (!session) {
      res.redirect(303, '/admin');
      return;
    }
    req.adminSession = session;
    next();
  } catch (err) {
    next(err);
  }
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

/* ------------------------------------------------------------------ */
/* Student sign-in session                                             */
/* ------------------------------------------------------------------ */

function studentHmac(value) {
  return crypto.createHmac('sha256', STUDENT_SESSION_SECRET)
    .update(`student-session-v1:${value}`)
    .digest('base64url');
}

function createStudentSession(student) {
  const issuedAt = Date.now();
  const payload = {
    v: 1,
    s: {
      name: student.name,
      id: student.id,
      grade: student.grade,
    },
    iat: issuedAt,
    exp: issuedAt + STUDENT_SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${STUDENT_SESSION_VERSION}.${body}.${studentHmac(body)}`, payload };
}

function readStudentSession(req) {
  const token = parseCookies(req)[STUDENT_COOKIE];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== STUDENT_SESSION_VERSION) return null;
  if (!safeEqual(parts[2], studentHmac(parts[1]))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || payload.v !== 1 || !payload.s || typeof payload.s !== 'object') return null;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
  const now = Date.now();
  if (payload.exp <= now || payload.iat > now + 60_000) return null;
  if (payload.exp - payload.iat > STUDENT_SESSION_TTL_MS + 60_000) return null;

  const identity = readStudentInput({
    studentName: payload.s.name,
    studentId: payload.s.id,
    grade: payload.s.grade,
  });
  if (!identity.ok) return null;

  return { ...payload, student: identity.student };
}

function studentCookie(req, value, maxAgeSeconds) {
  return buildCookie(req, STUDENT_COOKIE, value, maxAgeSeconds, '/', 'Lax');
}

function requireStudentSession(req, res, next) {
  const session = readStudentSession(req);
  if (!session) {
    res.set('Cache-Control', 'no-store');
    res.status(401).json({
      error: 'Sign in with your student details before submitting.',
      signInRequired: true,
    });
    return;
  }
  req.studentSession = session;
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

const studentLoginLimiter = createLimiter({
  limit: STUDENT_LOGIN_LIMIT,
  windowMs: STUDENT_LOGIN_WINDOW_MS,
  message: 'Too many sign-in attempts from this device. Wait a few minutes, then try again.',
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

app.get('/api/config', publicApiBlockGate, (req, res) => {
  const lanIp = pickLanIp();
  res.json({
    defaultBaseUrl: defaultBaseFor(req),
    lanUrls: lanIp && !ON_VERCEL ? [`http://${lanIp}:${activePort}`] : [],
    maxSeconds: MAX_SECONDS,
    retentionDays: RETENTION_DAYS,
    maxBytes: MAX_BYTES,
    storage: STORAGE_MODE,
    uploadEnabled: STORAGE_MODE !== 'unavailable',
    grades: GRADE_LEVELS,
    numberRange: { min: NUMBER_MIN, max: NUMBER_MAX },
  });
});

app.get('/api/board', publicApiBlockGate, async (req, res, next) => {
  try {
    const posts = await listBoardPosts({ force: true });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, posts });
  } catch (err) {
    next(err);
  }
});

app.get('/api/session', publicApiBlockGate, (req, res) => {
  const session = readStudentSession(req);
  res.set('Cache-Control', 'no-store');
  if (!session) {
    res.status(401).json({ ok: false, signedIn: false });
    return;
  }
  res.json({
    ok: true,
    signedIn: true,
    student: session.student,
    expiresAt: new Date(session.exp).toISOString(),
  });
});

app.post('/api/login', publicApiBlockGate, studentLoginLimiter, express.json({ limit: '8kb' }), (req, res) => {
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'Cross-origin sign-in was blocked.' });
    return;
  }

  const identity = readStudentInput(req.body && typeof req.body === 'object' ? req.body : {});
  if (!identity.ok) {
    res.status(400).json({ error: identity.errors.join(' '), fields: identity.errors });
    return;
  }

  const session = createStudentSession(identity.student);
  res.append('Set-Cookie', studentCookie(
    req,
    session.token,
    Math.floor(STUDENT_SESSION_TTL_MS / 1000),
  ));
  res.set('Cache-Control', 'no-store');
  logActivity({
    type: 'student.login',
    ip: clientIp(req),
    student: identity.student,
    detail: 'Student signed in before recording.',
  }).catch((err) => console.warn('Activity log warning:', err.message));
  res.json({
    ok: true,
    student: identity.student,
    expiresAt: new Date(session.payload.exp).toISOString(),
  });
});

app.post('/api/logout', publicApiBlockGate, express.json({ limit: '2kb' }), (req, res) => {
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'Cross-origin sign-out was blocked.' });
    return;
  }
  const session = readStudentSession(req);
  res.append('Set-Cookie', studentCookie(req, '', 0));
  res.set('Cache-Control', 'no-store');
  if (session) {
    logActivity({
      type: 'student.logout',
      ip: clientIp(req),
      student: session.student,
      detail: 'Student signed out.',
    }).catch((err) => console.warn('Activity log warning:', err.message));
  }
  res.status(204).end();
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

app.post('/api/recordings', publicApiBlockGate, uploadLimiter, requireStorage, requireStudentSession, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.size) throw httpError(400, 'No audio was uploaded.');
    if (req.file.size < 100) throw httpError(400, 'That audio file looks empty.');
    if (req.file.size > MAX_BYTES) throw httpError(413, 'That recording is too large.');

    const identity = { ok: true, student: req.studentSession.student };

    const mime = sniffAudioMime(req.file.buffer);
    if (!mime) throw httpError(415, 'Unsupported audio format. Please record again in your browser.');

    const ext = AUDIO_MIME_EXT[mime];
    const duration = clampNumber(Number(req.body.duration), 0, MAX_SECONDS, 0);
    const title = cleanTitle(req.body.title);
    const peaks = parsePeaks(req.body.peaks);
    const quality = analyzeAudioQuality({
      duration,
      peaks,
      stats: parseQualityStats(req.body.quality),
    });
    const autoplay = req.body.autoplay === '1' || req.body.autoplay === 'true';
    const code = await allocateCode();
    const createdAt = new Date();
    const expiresAt = RETENTION_DAYS > 0
      ? new Date(createdAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
      : null;
    const deleteToken = crypto.randomBytes(24).toString('base64url');
    const autoHidden = quality.score < 25;

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
      student: encryptJsonValue(identity.student),
      moderation: {
        status: autoHidden ? 'hidden' : 'pending',
        quality,
        note: autoHidden ? 'Automatically hidden because the audio quality is very poor.' : '',
        reviewedAt: '',
        reviewedBy: '',
        updatedAt: createdAt.toISOString(),
      },
    };

    await saveRecording(meta, req.file.buffer);
    touchPresence(req, { page: 'recorder', student: identity.student });

    await logActivity({
      type: 'recording.created',
      ip: clientIp(req),
      student: identity.student,
      code,
      title,
      detail: `Quality ${quality.score}/100 (${quality.label})${autoHidden ? ' · automatically hidden' : ''}`,
    }).catch((err) => console.warn('Activity log warning:', err.message));

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
      moderationStatus: meta.moderation.status,
      qualityScore: quality.score,
      underReview: !isPubliclyVisible(meta),
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/recordings/:code', publicApiBlockGate, async (req, res, next) => {
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
    await logActivity({
      type: 'recording.deleted',
      ip: clientIp(req),
      student: recordingStudent(meta),
      code: meta.code,
      title: meta.title,
      detail: 'Deleted by the recording owner.',
    }).catch((err) => console.warn('Activity log warning:', err.message));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get('/api/recordings/:code/qr.png', publicApiBlockGate, async (req, res, next) => {
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

app.get('/p/:code', publicPageBlockGate, async (req, res, next) => {
  try {
    const meta = await getPlayableRecording(req.params.code);
    if (!meta) {
      res.status(404).type('html').send(renderErrorPage(
        'This voice note has floated away.',
        'It may have expired or been deleted. You can record a new one in a few seconds.',
      ));
      return;
    }

    if (!isPubliclyVisible(meta)) {
      const moderation = moderationFor(meta);
      res.set('Cache-Control', 'no-store');
      res.status(403).type('html').send(renderErrorPage(
        moderation.status === 'flagged'
          ? 'This voice note has been removed.'
          : 'This voice note is under review.',
        moderation.status === 'flagged'
          ? 'An administrator removed this recording after a content review.'
          : 'An administrator is reviewing this recording before it can be played.',
      ));
      return;
    }

    touchPresence(req, { page: 'player', code: meta.code });
    await logActivity({
      type: 'recording.viewed',
      ip: clientIp(req),
      student: recordingStudent(meta),
      code: meta.code,
      title: meta.title,
      detail: 'Opened the public player.',
    }).catch((err) => console.warn('Activity log warning:', err.message));

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
  } catch (err) {
    next(err);
  }
});

app.get('/media/:code', publicMediaBlockGate, async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!CODE_PATTERN.test(code)) throw httpError(404, 'Recording not found.');

    const meta = await getPlayableRecording(code);
    if (!meta || !isPubliclyVisible(meta)) throw httpError(404, 'Recording not found.');

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

const presenceLimiter = createLimiter({
  limit: 180,
  windowMs: 5 * 60 * 1000,
  message: 'Too many presence updates.',
});

app.post('/api/presence', publicApiBlockGate, presenceLimiter, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const page = body.page === 'player' ? 'player' : 'recorder';
    const code = page === 'player' && CODE_PATTERN.test(String(body.code || ''))
      ? String(body.code)
      : '';
    const record = touchPresence(req, { page, code });
    if (!record) {
      res.status(204).end();
      return;
    }

    const now = Date.now();
    if (now - (record.visitLoggedAt || 0) > PRESENCE_LOG_INTERVAL_MS) {
      record.visitLoggedAt = now;
      logActivity({
        type: page === 'player' ? 'visitor.player' : 'visitor.recorder',
        ip: record.ip,
        code,
        detail: page === 'player' ? 'Player page active.' : 'Recorder page active.',
      }).catch((err) => console.warn('Activity log warning:', err.message));
    }

    res.json({ ok: true, active: true });
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

app.get('/admin', requireAdminConfigured, async (req, res, next) => {
  try {
    if (await readAdminSession(req)) {
      adminRedirect(res, '/admin/dashboard');
      return;
    }
    sendAdminPage(res, 200, renderAdminLoginPage({
      csrf: issueAdminLoginCsrf(req, res),
      error: '',
    }));
  } catch (err) {
    next(err);
  }
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
      ? await getAdminAccount(username)
      : undefined;
    const passwordOk = password.length <= 256
      ? await verifyPassword(password, account ? account.hash : ADMIN_TIMING_HASH)
      : false;

    if (!account || !passwordOk) {
      console.warn(`Admin sign-in failed from ${req.ip || 'unknown'}`);
      await logActivity({
        type: 'admin.login_failed',
        ip: clientIp(req),
        admin: username.slice(0, 80),
        detail: 'Incorrect username or password.',
      }).catch((err) => console.warn('Activity log warning:', err.message));
      sendAdminPage(res, 401, renderAdminLoginPage({
        csrf: issueAdminLoginCsrf(req, res),
        error: 'Incorrect username or password.',
      }));
      return;
    }

    loginLimiter.reset(req.ip || 'unknown');
    const session = createAdminSession(account);
    await logActivity({
      type: 'admin.login',
      ip: clientIp(req),
      admin: account.username,
      detail: 'Signed in to the admin console.',
    }).catch((err) => console.warn('Activity log warning:', err.message));
    res.append('Set-Cookie', adminLoginCsrfCookie(req, '', 0));
    res.append('Set-Cookie', adminCookie(req, session.token, Math.floor(ADMIN_SESSION_TTL_MS / 1000)));
    adminRedirect(res, '/admin/dashboard');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/logout', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res) => {
  await logActivity({
    type: 'admin.logout',
    ip: clientIp(req),
    admin: req.adminSession.u,
    detail: 'Signed out of the admin console.',
  }).catch((err) => console.warn('Activity log warning:', err.message));
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
    if (!(await readAdminSession(req))) {
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
    await logActivity({
      type: 'admin.recording_deleted',
      ip: clientIp(req),
      admin: req.adminSession.u,
      student: recordingStudent(meta),
      code: meta.code,
      title: meta.title,
      detail: 'Deleted permanently from the admin console.',
    }).catch((err) => console.warn('Activity log warning:', err.message));
    adminRedirect(res, '/admin/dashboard?status=deleted');
  } catch (err) {
    console.error('Admin delete failed:', err);
    adminRedirect(res, '/admin/dashboard?status=error');
  }
});

app.get('/admin/screening', requireAdminConfigured, requireAdminSession, async (req, res, next) => {
  try {
    const filter = ['all', 'review', 'poor', 'hidden', 'flagged', 'approved'].includes(String(req.query.filter || ''))
      ? String(req.query.filter)
      : 'review';
    const query = String(req.query.q || '').trim().slice(0, 80);
    const status = String(req.query.status || '');

    let recordings = [];
    let listError = '';
    if (STORAGE_MODE === 'unavailable') {
      listError = 'Storage is not connected on this deployment, so recordings cannot be listed.';
    } else {
      try {
        recordings = await listRecordings();
      } catch (err) {
        console.error('Could not list recordings for screening:', err);
        listError = 'Recordings could not be loaded right now. Refresh to try again.';
      }
    }

    sendAdminPage(res, 200, renderAdminScreeningPage({
      recordings,
      csrf: req.adminSession.csrf,
      filter,
      query,
      status,
      listError,
      storageLabel: STORAGE_MODE === 'blob' ? 'Vercel Blob' : STORAGE_MODE === 'file' ? 'Local disk' : 'Not connected',
    }), mediaOriginsFor(recordings));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/recordings/:code/moderate', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const code = String(req.params.code);
    const action = String((req.body && req.body.action) || '');
    const target = { approve: 'approved', hide: 'hidden', flag: 'flagged' }[action];
    const filter = ['all', 'review', 'poor', 'hidden', 'flagged', 'approved'].includes(String(req.body.filter || ''))
      ? String(req.body.filter)
      : 'review';

    if (!target || !CODE_PATTERN.test(code)) {
      adminRedirect(res, `/admin/screening?status=error&filter=${encodeURIComponent(filter)}`);
      return;
    }

    const meta = await readMeta(code);
    if (!meta) {
      adminRedirect(res, `/admin/screening?status=missing&filter=${encodeURIComponent(filter)}`);
      return;
    }

    const current = moderationFor(meta);
    const note = String((req.body && req.body.note) || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const now = new Date().toISOString();

    meta.moderation = {
      status: target,
      quality: current.quality,
      note,
      reviewedAt: now,
      reviewedBy: req.adminSession.u,
      updatedAt: now,
    };
    await writeMeta(meta);

    await logActivity({
      type: `moderation.${target}`,
      ip: clientIp(req),
      admin: req.adminSession.u,
      student: recordingStudent(meta),
      code: meta.code,
      title: meta.title,
      detail: note || `Marked ${MODERATION_LABELS[target].toLowerCase()}.`,
    }).catch((err) => console.warn('Activity log warning:', err.message));

    adminRedirect(res, `/admin/screening?status=${target}&filter=${encodeURIComponent(filter)}`);
  } catch (err) {
    next(err);
  }
});

app.get('/admin/users', requireAdminConfigured, requireAdminSession, async (req, res, next) => {
  try {
    const status = String(req.query.status || '');
    let blocks = [];
    let activity = [];
    try {
      [blocks, activity] = await Promise.all([
        readBlocks({ force: true }),
        listActivityEntries(200),
      ]);
    } catch (err) {
      console.warn('Active users data warning:', err.message);
    }

    const recentByIp = new Map();
    for (const entry of activity) {
      const ip = normalizeIp(entry.ip);
      if (!ip || recentByIp.has(ip)) continue;
      recentByIp.set(ip, {
        ip,
        lastSeen: entry.at,
        detail: entry.detail || entry.type || 'Public interaction',
      });
    }

    sendAdminPage(res, 200, renderAdminUsersPage({
      csrf: req.adminSession.csrf,
      presence: listPresence(),
      blocks,
      recent: [...recentByIp.values()].slice(0, 40),
      currentIp: clientIp(req),
      status,
    }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/blocks', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const ip = String((req.body && req.body.ip) || '').trim();
    const reason = String((req.body && req.body.reason) || '');
    try {
      const record = await addIpBlock({
        ip,
        reason,
        blockedBy: req.adminSession.u,
      });
      await logActivity({
        type: 'ip.blocked',
        ip: record.ip,
        admin: req.adminSession.u,
        detail: record.reason,
      }).catch((err) => console.warn('Activity log warning:', err.message));
      adminRedirect(res, '/admin/users?status=blocked');
    } catch (err) {
      const status = err.status === 409 ? 'block-exists' : 'block-invalid';
      adminRedirect(res, `/admin/users?status=${status}`);
    }
  } catch (err) {
    next(err);
  }
});

app.post('/admin/blocks/:ip/unblock', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const ip = String(req.params.ip || '');
    try {
      const record = await removeIpBlock(ip);
      if (!record) {
        adminRedirect(res, '/admin/users?status=unblock-missing');
        return;
      }
      await logActivity({
        type: 'ip.unblocked',
        ip: record.ip,
        admin: req.adminSession.u,
        detail: record.reason,
      }).catch((err) => console.warn('Activity log warning:', err.message));
      adminRedirect(res, '/admin/users?status=unblocked');
    } catch {
      adminRedirect(res, '/admin/users?status=unblock-error');
    }
  } catch (err) {
    next(err);
  }
});

app.get('/admin/admins', requireAdminConfigured, requireAdminSession, async (req, res, next) => {
  try {
    const admins = await listAdminAccounts();
    sendAdminPage(res, 200, renderAdminManagementPage({
      csrf: req.adminSession.csrf,
      admins,
      currentUsername: req.adminSession.u,
      status: String(req.query.status || ''),
    }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/admins', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const validation = validateNewAdmin({
      username: req.body && req.body.username,
      password: req.body && req.body.password,
      confirmPassword: req.body && req.body.confirmPassword,
    });
    if (!validation.ok) {
      adminRedirect(res, '/admin/admins?status=admin-invalid');
      return;
    }

    try {
      const record = await addDynamicAdmin({
        username: validation.username,
        password: validation.password,
        createdBy: req.adminSession.u,
      });
      await logActivity({
        type: 'admin.added',
        ip: clientIp(req),
        admin: req.adminSession.u,
        detail: `Added administrator ${record.username}.`,
      }).catch((err) => console.warn('Activity log warning:', err.message));
      adminRedirect(res, '/admin/admins?status=admin-added');
    } catch (err) {
      const status = err.status === 409 ? 'admin-exists' : 'admin-error';
      adminRedirect(res, `/admin/admins?status=${status}`);
    }
  } catch (err) {
    next(err);
  }
});

app.post('/admin/admins/:username/remove', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const username = String(req.params.username || '');
    if (username === req.adminSession.u) {
      adminRedirect(res, '/admin/admins?status=admin-self');
      return;
    }

    try {
      const account = await removeDynamicAdmin(username);
      await logActivity({
        type: 'admin.removed',
        ip: clientIp(req),
        admin: req.adminSession.u,
        detail: `Removed administrator ${account.username}.`,
      }).catch((err) => console.warn('Activity log warning:', err.message));
      adminRedirect(res, '/admin/admins?status=admin-removed');
    } catch (err) {
      const status = err.status === 403 ? 'admin-protected' : err.status === 404 ? 'admin-missing' : 'admin-error';
      adminRedirect(res, `/admin/admins?status=${status}`);
    }
  } catch (err) {
    next(err);
  }
});

app.get('/admin/activity', requireAdminConfigured, requireAdminSession, async (req, res, next) => {
  try {
    const category = ['all', 'visitors', 'recordings', 'moderation', 'security', 'admins', 'board'].includes(String(req.query.category || ''))
      ? String(req.query.category)
      : 'all';
    const query = String(req.query.q || '').trim().slice(0, 100);
    let entries = [];
    let listError = '';
    try {
      entries = await listActivityEntries(300);
    } catch (err) {
      console.warn('Activity load warning:', err.message);
      listError = 'The activity log could not be loaded right now.';
    }

    const matchesCategory = (entry) => category === 'all' || activityCategory(entry.type) === category;
    const needle = query.toLowerCase();
    const filtered = entries.filter((entry) => {
      if (!matchesCategory(entry)) return false;
      if (!needle) return true;
      const haystack = [
        activityLabel(entry.type),
        entry.type,
        entry.ip,
        entry.admin,
        entry.code,
        entry.title,
        entry.detail,
        entry.student && entry.student.name,
        entry.student && entry.student.id,
        entry.student && entry.student.grade,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    });

    sendAdminPage(res, 200, renderAdminActivityPage({
      csrf: req.adminSession.csrf,
      entries: filtered,
      total: entries.length,
      category,
      query,
      listError,
    }));
  } catch (err) {
    next(err);
  }
});

app.get('/admin/board', requireAdminConfigured, requireAdminSession, async (req, res, next) => {
  try {
    const posts = await listBoardPosts({ force: true });
    sendAdminPage(res, 200, renderAdminBoardPage({
      csrf: req.adminSession.csrf,
      posts,
      status: String(req.query.status || ''),
    }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/board', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const input = readBoardInput(req.body);
    if (!input.ok) {
      adminRedirect(res, '/admin/board?status=post-invalid');
      return;
    }

    const post = await addBoardPost({
      ...input.post,
      author: req.adminSession.u,
    });
    await logActivity({
      type: 'board.posted',
      ip: clientIp(req),
      admin: req.adminSession.u,
      detail: post.title,
    }).catch((err) => console.warn('Activity log warning:', err.message));
    adminRedirect(res, '/admin/board?status=posted');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/board/:id/delete', requireAdminConfigured, adminForm, requireAdminSession, requireAdminCsrf, async (req, res, next) => {
  try {
    const post = await removeBoardPost(String(req.params.id || ''));
    if (!post) {
      adminRedirect(res, '/admin/board?status=post-missing');
      return;
    }
    await logActivity({
      type: 'board.removed',
      ip: clientIp(req),
      admin: req.adminSession.u,
      detail: post.title,
    }).catch((err) => console.warn('Activity log warning:', err.message));
    adminRedirect(res, '/admin/board?status=post-removed');
  } catch (err) {
    next(err);
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

app.get(['/', '/index.html', '/details'], publicPageBlockGate, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'details.html'));
});

app.get('/record', publicPageBlockGate, (req, res, next) => {
  try {
    const session = readStudentSession(req);
    if (!session) {
      res.set('Cache-Control', 'no-store');
      res.redirect(303, '/');
      return;
    }
    res.sendFile(path.join(VIEWS_DIR, 'recorder.html'));
  } catch (err) {
    next(err);
  }
});

app.get('/board', publicPageBlockGate, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'board.html'));
});

app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

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
    const payload = { error: status >= 500 ? 'Something went wrong on the server.' : err.message };
    if (Array.isArray(err.fields) && err.fields.length) payload.fields = err.fields;
    if (err.blocked) {
      payload.blocked = true;
      payload.reason = err.reason || '';
      payload.blockedAt = err.blockedAt || '';
    }
    res.status(status).json(payload);
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
<body data-autoplay="${autoplay ? '1' : '0'}" data-duration="${Number(meta.duration) || 0}" data-code="${escapeHtml(meta.code)}">
  <div class="aurora" aria-hidden="true">
    <span class="aurora-blob blob-a"></span>
    <span class="aurora-blob blob-b"></span>
    <span class="aurora-blob blob-c"></span>
  </div>

  <div class="player-blocked" id="playerBlocked" role="alert" hidden>
    <div class="player-blocked-card">
      <span class="player-blocked-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/>
          <path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v3"/>
        </svg>
      </span>
      <p class="eyebrow">Access blocked</p>
      <h2>An administrator blocked this connection.</h2>
      <p id="playerBlockedReason">This IP address cannot use EchoTag right now.</p>
      <p class="player-blocked-help">Contact the administrator if you believe this is a mistake.</p>
    </div>
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

const ADMIN_NAV_ITEMS = Object.freeze([
  { id: 'dashboard', label: 'Recordings', href: '/admin/dashboard' },
  { id: 'screening', label: 'Screening', href: '/admin/screening' },
  { id: 'users', label: 'Active users', href: '/admin/users' },
  { id: 'board', label: 'Bulletin board', href: '/admin/board' },
  { id: 'admins', label: 'Administrators', href: '/admin/admins' },
  { id: 'activity', label: 'Activity log', href: '/admin/activity' },
]);

function adminNavHtml(active) {
  return `<nav class="admin-nav" aria-label="Admin sections">
    ${ADMIN_NAV_ITEMS.map((item) => `<a class="admin-nav-link${item.id === active ? ' is-active' : ''}" href="${item.href}"${item.id === active ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`).join('')}
  </nav>`;
}

function renderAdminPageFrame({ title, csrf, active, refreshHref, content }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)} · ${APP_NAME} admin</title>
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
      <a class="button ghost small" href="${escapeHtml(refreshHref || '/admin/dashboard')}">Refresh</a>
      <form class="inline-form" method="post" action="/admin/logout">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <button class="button ghost small" type="submit">Sign out</button>
      </form>
    </div>
  </header>
  ${adminNavHtml(active)}

  <main class="admin-shell">
    ${content}
    <footer class="admin-footer">
      <p>© Sinsana Studio 2026 · All rights reserved.</p>
      <p><a href="/">EchoTag home</a></p>
    </footer>
  </main>
  <script src="/admin.js" defer></script>
</body>
</html>`;
}

function renderAdminStatus(status, messages) {
  if (!status || !messages[status]) return '';
  const success = /(?:deleted|approved|blocked|unblocked|added|removed|updated)/.test(status);
  return `<p class="alert ${success ? 'alert-ok' : 'alert-warn'}" role="status">${escapeHtml(messages[status])}</p>`;
}

function relativeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 'Unknown';
  const diff = Date.now() - time;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} hr ago`;
  return formatDateTime(date.toISOString());
}

function moderationBadge(meta) {
  const status = moderationFor(meta).status;
  return `<span class="badge badge-${status}">${escapeHtml(MODERATION_LABELS[status])}</span>`;
}

function qualityBadge(quality) {
  const score = Number(quality && quality.score);
  if (!Number.isFinite(score)) return '<span class="badge badge-muted">No quality analysis</span>';
  const tone = score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor';
  return `<span class="badge badge-quality-${tone}">Quality ${Math.round(score)}/100</span>`;
}

function renderStudentIdentity(meta, { compact = true } = {}) {
  const student = recordingStudent(meta);
  if (!student) return '<span class="identity-chip identity-missing">No identity on file</span>';
  if (compact) {
    return `<span class="identity-chip">${escapeHtml(student.name)} · ${escapeHtml(student.id)} · ${escapeHtml(student.grade)}</span>`;
  }
  return `<span class="identity-chip"><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.id)}</span><span>${escapeHtml(student.grade)}</span></span>`;
}

function activityCategory(type) {
  const value = String(type || '');
  if (value === 'admin.recording_deleted') return 'recordings';
  if (value.startsWith('board.')) return 'board';
  if (value.startsWith('moderation.')) return 'moderation';
  if (value.startsWith('ip.') || value === 'admin.login_failed') return 'security';
  if (value.startsWith('admin.')) return 'admins';
  if (value === 'recording.viewed' || value.startsWith('visitor.') || value.startsWith('student.')) return 'visitors';
  if (value.startsWith('recording.')) return 'recordings';
  return 'other';
}

const ACTIVITY_LABELS = Object.freeze({
  'recording.created': 'Recording created',
  'recording.viewed': 'Player opened',
  'recording.deleted': 'Recording deleted by owner',
  'admin.recording_deleted': 'Recording deleted by admin',
  'moderation.approved': 'Recording approved',
  'moderation.hidden': 'Recording hidden',
  'moderation.flagged': 'Recording flagged',
  'admin.login': 'Admin signed in',
  'admin.login_failed': 'Admin sign-in failed',
  'admin.logout': 'Admin signed out',
  'admin.added': 'Administrator added',
  'admin.removed': 'Administrator removed',
  'ip.blocked': 'IP address blocked',
  'ip.unblocked': 'IP address unblocked',
  'visitor.recorder': 'Recorder page active',
  'visitor.player': 'Player page active',
  'student.login': 'Student signed in',
  'student.logout': 'Student signed out',
  'board.posted': 'Bulletin posted',
  'board.removed': 'Bulletin removed',
});

const ACTIVITY_CATEGORY_LABELS = Object.freeze({
  all: 'All events',
  visitors: 'Visitors',
  recordings: 'Recordings',
  moderation: 'Moderation',
  security: 'Security',
  admins: 'Administrators',
  board: 'Bulletin board',
});

function activityLabel(type) {
  return ACTIVITY_LABELS[type] || String(type || 'Activity');
}

function renderBlockedPage(block) {
  const blockedAt = block && block.blockedAt ? formatDateTime(block.blockedAt) : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access blocked · ${APP_NAME}</title>
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
      <div class="error-orb blocked-orb" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/>
          <path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v3"/>
        </svg>
      </div>
      <p class="eyebrow">Access blocked</p>
      <h1>Blocked by an administrator</h1>
      <p class="error-copy">This IP address cannot use EchoTag right now.</p>
      <p class="blocked-reason"><span>Reason</span>${escapeHtml(block && block.reason ? block.reason : 'No reason provided.')}</p>
      ${blockedAt ? `<p class="blocked-time">Blocked ${escapeHtml(blockedAt)}</p>` : ''}
      <p class="blocked-help">If you believe this is a mistake, contact the administrator of this EchoTag site.</p>
    </div>
    <p class="error-copyright">© Sinsana Studio 2026 · All rights reserved.</p>
  </main>
</body>
</html>`;
}

function renderAdminScreeningPage({ recordings, csrf, filter, query, status, listError, storageLabel }) {
  const counts = { all: recordings.length, review: 0, poor: 0, hidden: 0, flagged: 0, approved: 0 };
  for (const meta of recordings) {
    const moderation = moderationFor(meta);
    if (moderation.status === 'pending') counts.review += 1;
    if (moderation.quality && Number(moderation.quality.score) < 60) counts.poor += 1;
    if (moderation.status === 'hidden') counts.hidden += 1;
    if (moderation.status === 'flagged') counts.flagged += 1;
    if (moderation.status === 'approved') counts.approved += 1;
  }

  const needle = query.toLowerCase();
  const filtered = recordings.filter((meta) => {
    const moderation = moderationFor(meta);
    if (filter === 'review' && moderation.status !== 'pending') return false;
    if (filter === 'poor' && !(moderation.quality && Number(moderation.quality.score) < 60)) return false;
    if (filter === 'hidden' && moderation.status !== 'hidden') return false;
    if (filter === 'flagged' && moderation.status !== 'flagged') return false;
    if (filter === 'approved' && moderation.status !== 'approved') return false;
    if (!needle) return true;
    const student = recordingStudent(meta);
    const haystack = [
      meta.title,
      meta.code,
      moderation.status,
      moderation.quality && moderation.quality.reasons && moderation.quality.reasons.join(' '),
      student && student.name,
      student && student.id,
      student && student.grade,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(needle);
  });

  const statusMessages = {
    approved: 'The recording is approved and publicly playable.',
    hidden: 'The recording is hidden from public playback.',
    flagged: 'The recording is flagged and hidden from public playback.',
    updated: 'The review status was updated.',
    missing: 'That recording was already gone.',
    error: 'The review action could not be saved. Try again.',
  };
  const filterLabels = {
    review: 'Needs review',
    poor: 'Poor quality',
    hidden: 'Hidden',
    flagged: 'Flagged',
    approved: 'Approved',
    all: 'All recordings',
  };
  const filterLinks = Object.entries(filterLabels).map(([key, label]) => {
    const href = `/admin/screening?filter=${key}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
    return `<a class="filter-chip${filter === key ? ' is-active' : ''}" href="${href}">${escapeHtml(label)} <span>${counts[key]}</span></a>`;
  }).join('');

  const rows = filtered.map((meta) => {
    const moderation = moderationFor(meta);
    const quality = moderation.quality;
    const student = recordingStudent(meta);
    const reasons = quality && Array.isArray(quality.reasons) && quality.reasons.length
      ? quality.reasons.join(' · ')
      : 'No quality problems detected.';
    const search = escapeHtml([
      meta.title,
      meta.code,
      moderation.status,
      student && student.name,
      student && student.id,
      student && student.grade,
      reasons,
    ].filter(Boolean).join(' ').toLowerCase());
    const confirmText = `Delete &quot;${escapeHtml(meta.title || 'Voice note')}&quot; permanently?`;

    return `<article class="screening-card" data-search="${search}">
      <div class="screening-head">
        <div>
          <h3 class="recording-title">${escapeHtml(meta.title || 'Voice note')}</h3>
          <p class="recording-meta">
            <span class="code-pill">${escapeHtml(meta.code)}</span>
            <span>${escapeHtml(formatDateTime(meta.createdAt))}</span>
            <span>${meta.duration ? escapeHtml(formatDuration(meta.duration)) : '—'}</span>
            <span>${escapeHtml(formatBytes(meta.size))}</span>
          </p>
        </div>
        <div class="badge-row">
          ${moderationBadge(meta)}
          ${qualityBadge(quality)}
        </div>
      </div>
      <p class="screening-identity">${renderStudentIdentity(meta, { compact: false })}</p>
      <p class="quality-reasons ${quality && quality.score < 50 ? 'is-poor' : ''}">${escapeHtml(reasons)}</p>
      ${moderation.note ? `<p class="review-note"><strong>Review note:</strong> ${escapeHtml(moderation.note)}</p>` : ''}
      ${moderation.reviewedBy ? `<p class="review-meta">Reviewed by ${escapeHtml(moderation.reviewedBy)} · ${escapeHtml(relativeTime(moderation.reviewedAt))}</p>` : ''}
      <audio controls preload="none" src="/admin/audio/${encodeURIComponent(meta.code)}"></audio>
      <div class="screening-actions">
        <form class="moderation-form" method="post" action="/admin/recordings/${encodeURIComponent(meta.code)}/moderate">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="filter" value="${escapeHtml(filter)}">
          <input class="note-input" type="text" name="note" maxlength="300" placeholder="Review note (optional)" aria-label="Review note for ${escapeHtml(meta.title || 'voice note')}">
          <button class="button small approve" name="action" value="approve" type="submit">Approve</button>
          <button class="button small" name="action" value="hide" type="submit">Hide</button>
          <button class="button small danger" name="action" value="flag" type="submit">Flag inappropriate</button>
        </form>
        <a class="button ghost small" href="/p/${encodeURIComponent(meta.code)}" target="_blank" rel="noopener">Open player</a>
        <form method="post" action="/admin/recordings/${encodeURIComponent(meta.code)}/delete" data-confirm="${confirmText}">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
          <button class="button danger small" type="submit">Delete</button>
        </form>
      </div>
    </article>`;
  }).join('');

  const content = `
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Audio screening</p>
      <h1>Listen. Then decide.</h1>
      <p class="hero-copy">Recordings are scored automatically for silence, low signal, short clips, and clipping. Hidden and flagged notes are removed from public playback. Storage: <strong>${escapeHtml(storageLabel)}</strong>.</p>
      <div class="stats stats-five">
        <div class="stat"><span>Needs review</span><strong>${counts.review}</strong></div>
        <div class="stat"><span>Poor quality</span><strong>${counts.poor}</strong></div>
        <div class="stat"><span>Hidden</span><strong>${counts.hidden}</strong></div>
        <div class="stat"><span>Flagged</span><strong>${counts.flagged}</strong></div>
        <div class="stat"><span>Approved</span><strong>${counts.approved}</strong></div>
      </div>
    </section>

    ${renderAdminStatus(status, statusMessages)}
    ${listError ? `<p class="alert alert-warn" role="alert">${escapeHtml(listError)}</p>` : ''}

    <section class="panel">
      <div class="toolbar toolbar-stack">
        <div>
          <h2>Review queue</h2>
          <p>${filtered.length} of ${recordings.length} recordings shown</p>
        </div>
        <form class="search" method="get" action="/admin/screening" role="search">
          <input type="hidden" name="filter" value="${escapeHtml(filter)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search name, number, title, or code" autocomplete="off">
        </form>
      </div>
      <div class="filter-row">${filterLinks}</div>
      <div class="screening-list">
        ${rows || `<div class="empty-state">
          <div class="empty-orb" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v10M8 7v4M16 7v4M5 13a7 7 0 0 0 14 0M12 20v1"/></svg>
          </div>
          <h3>Nothing in this queue</h3>
          <p>Try another filter, clear the search, or wait for new recordings.</p>
          <a class="button ghost small" href="/admin/screening?filter=all">Show all recordings</a>
        </div>`}
      </div>
    </section>`;

  return renderAdminPageFrame({
    title: 'Audio screening',
    csrf,
    active: 'screening',
    refreshHref: `/admin/screening?filter=${encodeURIComponent(filter)}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
    content,
  });
}

function renderAdminUsersPage({ csrf, presence, blocks, recent, currentIp, status }) {
  const statusMessages = {
    blocked: 'The IP address is now blocked. Public EchoTag access from that address will show the block notice.',
    'block-exists': 'That IP address is already blocked.',
    'block-invalid': 'Enter a valid IP address and a reason of at least 3 characters.',
    unblocked: 'The IP address was unblocked.',
    'unblock-missing': 'That IP address was not in the block list.',
    'unblock-error': 'The IP address could not be unblocked. Try again.',
  };
  const blockMap = new Map(blocks.map((block) => [normalizeIp(block.ip), block]));
  const activeNow = presence.filter((record) => record.active).length;

  const presenceRows = presence.map((record) => {
    const block = blockMap.get(record.ip);
    const student = record.student;
    return `<tr>
      <td>
        <span class="ip-pill">${escapeHtml(record.ip)}</span>
        ${record.ip === currentIp ? '<span class="self-tag">You</span>' : ''}
        ${block ? '<span class="badge badge-flagged">Blocked</span>' : '<span class="badge badge-active">Active</span>'}
      </td>
      <td>${escapeHtml(record.page === 'player' ? (record.code ? `Player · ${record.code}` : 'Player') : 'Recorder')}</td>
      <td>${student ? escapeHtml(`${student.name} · ${student.id} · ${student.grade}`) : '<span class="muted-text">Not submitted</span>'}</td>
      <td><span title="${escapeHtml(record.userAgent)}">${escapeHtml(record.userAgent ? record.userAgent.slice(0, 46) : 'Unknown device')}${record.userAgent && record.userAgent.length > 46 ? '…' : ''}</span></td>
      <td>${escapeHtml(relativeTime(record.lastSeen))}</td>
      <td>
        ${block
          ? `<form method="post" action="/admin/blocks/${encodeURIComponent(record.ip)}/unblock">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
              <button class="button ghost small" type="submit">Unblock</button>
            </form>`
          : `<form class="inline-block-form" method="post" action="/admin/blocks">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="ip" value="${escapeHtml(record.ip)}">
              <input class="reason-input" type="text" name="reason" minlength="3" maxlength="200" placeholder="Reason required" required aria-label="Reason for blocking ${escapeHtml(record.ip)}">
              <button class="button danger small" type="submit">Block IP</button>
            </form>`}
      </td>
    </tr>`;
  }).join('');

  const recentRows = recent.filter((entry) => !presence.some((record) => record.ip === entry.ip)).map((entry) => {
    const block = blockMap.get(entry.ip);
    return `<tr>
      <td><span class="ip-pill">${escapeHtml(entry.ip)}</span> ${block ? '<span class="badge badge-flagged">Blocked</span>' : ''}</td>
      <td>${escapeHtml(entry.detail)}</td>
      <td>${escapeHtml(relativeTime(entry.lastSeen))}</td>
      <td>
        ${block
          ? `<form method="post" action="/admin/blocks/${encodeURIComponent(entry.ip)}/unblock">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
              <button class="button ghost small" type="submit">Unblock</button>
            </form>`
          : `<form class="inline-block-form" method="post" action="/admin/blocks">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="ip" value="${escapeHtml(entry.ip)}">
              <input class="reason-input" type="text" name="reason" minlength="3" maxlength="200" placeholder="Reason required" required aria-label="Reason for blocking ${escapeHtml(entry.ip)}">
              <button class="button danger small" type="submit">Block IP</button>
            </form>`}
      </td>
    </tr>`;
  }).join('');

  const blockedRows = blocks.map((block) => `<tr>
    <td><span class="ip-pill">${escapeHtml(block.ip)}</span></td>
    <td>${escapeHtml(block.reason)}</td>
    <td>${escapeHtml(block.blockedBy || 'Administrator')}</td>
    <td>${escapeHtml(relativeTime(block.blockedAt))}</td>
    <td>
      <form method="post" action="/admin/blocks/${encodeURIComponent(block.ip)}/unblock">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <button class="button ghost small" type="submit">Unblock</button>
      </form>
    </td>
  </tr>`).join('');

  const content = `
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Access control</p>
      <h1>Who is here right now.</h1>
      <p class="hero-copy">Active visitors are tracked by IP address from recorder and player heartbeats. Blocking requires a reason, and blocked visitors see a notice naming the administrator’s action. Your current IP is <strong>${escapeHtml(currentIp)}</strong>.</p>
      <div class="stats">
        <div class="stat"><span>Active now</span><strong>${activeNow}</strong></div>
        <div class="stat"><span>Tracked visitors</span><strong>${presence.length}</strong></div>
        <div class="stat"><span>Blocked IPs</span><strong>${blocks.length}</strong></div>
        <div class="stat"><span>Recent IPs</span><strong>${recent.length}</strong></div>
      </div>
    </section>

    ${renderAdminStatus(status, statusMessages)}

    <section class="panel panel-pad">
      <div class="toolbar toolbar-bare">
        <div>
          <h2>Block an IP address</h2>
          <p>The reason is required and is shown to the blocked visitor.</p>
        </div>
      </div>
      <form class="admin-form-grid" method="post" action="/admin/blocks">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <label class="field">
          <span>IP address</span>
          <input type="text" name="ip" inputmode="text" spellcheck="false" maxlength="64" placeholder="203.0.113.25" required>
        </label>
        <label class="field">
          <span>Reason (required)</span>
          <input type="text" name="reason" minlength="3" maxlength="200" placeholder="Repeated inappropriate recordings" required>
        </label>
        <button class="button danger" type="submit">Block IP</button>
      </form>
    </section>

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Active users</h2>
          <p>Seen in the last 2 minutes · refreshes when you reload</p>
        </div>
      </div>
      <div class="table-wrap">
        ${presence.length ? `<table class="admin-table">
          <thead><tr><th>IP address</th><th>Page</th><th>Student</th><th>Device</th><th>Last seen</th><th>Action</th></tr></thead>
          <tbody>${presenceRows}</tbody>
        </table>` : `<div class="empty-state"><h3>No active visitors</h3><p>Recorder and player heartbeats will appear here.</p></div>`}
      </div>
    </section>

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Blocked IP addresses</h2>
          <p>${blocks.length} ${blocks.length === 1 ? 'address' : 'addresses'} blocked</p>
        </div>
      </div>
      <div class="table-wrap">
        ${blocks.length ? `<table class="admin-table">
          <thead><tr><th>IP address</th><th>Reason</th><th>Blocked by</th><th>Blocked</th><th>Action</th></tr></thead>
          <tbody>${blockedRows}</tbody>
        </table>` : `<div class="empty-state"><h3>No blocked addresses</h3><p>Blocked visitors will be listed here with the reason they were blocked.</p></div>`}
      </div>
    </section>

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Recent IP addresses</h2>
          <p>From the activity log, including visitors who are no longer active.</p>
        </div>
      </div>
      <div class="table-wrap">
        ${recentRows ? `<table class="admin-table">
          <thead><tr><th>IP address</th><th>Last activity</th><th>Last seen</th><th>Action</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>` : `<div class="empty-state"><h3>No recent activity</h3><p>Visit activity will appear after someone records or opens a player.</p></div>`}
      </div>
    </section>`;

  return renderAdminPageFrame({
    title: 'Active users',
    csrf,
    active: 'users',
    refreshHref: '/admin/users',
    content,
  });
}

function renderAdminManagementPage({ csrf, admins, currentUsername, status }) {
  const statusMessages = {
    'admin-added': 'The new administrator can sign in immediately.',
    'admin-removed': 'The administrator account was removed.',
    'admin-invalid': 'Check the username and password requirements, then try again.',
    'admin-exists': 'An administrator with that username already exists.',
    'admin-self': 'You cannot remove the account you are signed in with.',
    'admin-protected': 'Built-in administrators come from environment variables and cannot be removed here.',
    'admin-missing': 'That administrator was already gone.',
    'admin-error': 'The administrator list could not be updated. Try again.',
  };

  const rows = admins.map((account) => {
    const created = account.source === 'added'
      ? `${escapeHtml(account.createdBy || 'Administrator')} · ${escapeHtml(relativeTime(account.createdAt))}`
      : 'Configured by environment variables';
    const action = account.source === 'built-in'
      ? '<span class="muted-text">Protected</span>'
      : account.username === currentUsername
        ? '<span class="muted-text">Current account</span>'
        : `<form method="post" action="/admin/admins/${encodeURIComponent(account.username)}/remove" data-confirm="Remove administrator ${escapeHtml(account.username)}? They will lose access immediately.">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
            <button class="button danger small" type="submit">Remove</button>
          </form>`;
    return `<tr>
      <td><strong>${escapeHtml(account.username)}</strong>${account.username === currentUsername ? '<span class="self-tag">You</span>' : ''}</td>
      <td><span class="badge ${account.source === 'built-in' ? 'badge-approved' : 'badge-pending'}">${account.source === 'built-in' ? 'Built-in' : 'Added'}</span></td>
      <td>${created}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');

  const content = `
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Administrator access</p>
      <h1>Who can open the console.</h1>
      <p class="hero-copy">Built-in accounts come from <code>ADMIN_USERNAME</code> and <code>ADMIN_USERS</code>. Added administrators are stored securely and can be removed here. Every account has full access to recordings, blocking, and the activity log.</p>
    </section>

    ${renderAdminStatus(status, statusMessages)}

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Current administrators</h2>
          <p>${admins.length} ${admins.length === 1 ? 'account' : 'accounts'}</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>Username</th><th>Type</th><th>Added</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-pad">
      <div class="toolbar toolbar-bare">
        <div>
          <h2>Add an administrator</h2>
          <p>Use at least 10 characters. Share the password through a private channel.</p>
        </div>
      </div>
      <form class="admin-form-grid admin-form-grid-compact" method="post" action="/admin/admins" autocomplete="off">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <label class="field">
          <span>Username</span>
          <input type="text" name="username" minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,39}" autocomplete="off" spellcheck="false" required>
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" minlength="10" maxlength="200" autocomplete="new-password" required>
        </label>
        <label class="field">
          <span>Confirm password</span>
          <input type="password" name="confirmPassword" minlength="10" maxlength="200" autocomplete="new-password" required>
        </label>
        <button class="button primary compact-button" type="submit">Add administrator</button>
      </form>
    </section>`;

  return renderAdminPageFrame({
    title: 'Administrators',
    csrf,
    active: 'admins',
    refreshHref: '/admin/admins',
    content,
  });
}

function renderAdminBoardPage({ csrf, posts, status }) {
  const statusMessages = {
    posted: 'The bulletin is live on the public board.',
    'post-removed': 'The bulletin was removed from the public board.',
    'post-missing': 'That bulletin was already gone.',
    'post-invalid': 'Add a title and a message before posting.',
  };

  const postCards = posts.map((post) => `<article class="board-admin-post">
    <div class="board-admin-head">
      <h3>${escapeHtml(post.title)}</h3>
      <span class="board-admin-meta">${escapeHtml(post.author || 'Administrator')} · ${escapeHtml(relativeTime(post.createdAt))}</span>
    </div>
    <p class="board-admin-body">${escapeHtml(post.body)}</p>
    <form method="post" action="/admin/board/${encodeURIComponent(post.id)}/delete" data-confirm="Remove “${escapeHtml(post.title)}” from the public bulletin board?">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
      <button class="button danger small" type="submit">Remove post</button>
    </form>
  </article>`).join('');

  const content = `
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Public bulletin board</p>
      <h1>Post announcements for everyone.</h1>
      <p class="hero-copy">Every bulletin is readable by anyone who visits the board. Only administrators can post or remove announcements. The board keeps the ${BOARD_LIMIT} most recent posts.</p>
      <div class="stats">
        <div class="stat"><span>Live bulletins</span><strong>${posts.length}</strong></div>
        <div class="stat"><span>Board limit</span><strong>${BOARD_LIMIT}</strong></div>
      </div>
    </section>

    ${renderAdminStatus(status, statusMessages)}

    <section class="panel panel-pad">
      <div class="toolbar toolbar-bare">
        <div>
          <h2>New bulletin</h2>
          <p>The title and message appear immediately on the public board.</p>
        </div>
      </div>
      <form class="board-compose" method="post" action="/admin/board">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <label class="field">
          <span>Title</span>
          <input type="text" name="title" minlength="2" maxlength="${BOARD_TITLE_MAX}" placeholder="Exam schedule update" required>
        </label>
        <label class="field">
          <span>Message</span>
          <textarea name="body" rows="5" minlength="2" maxlength="${BOARD_BODY_MAX}" placeholder="Write the announcement students should see." required></textarea>
        </label>
        <button class="button primary" type="submit">Publish bulletin</button>
      </form>
    </section>

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Published bulletins</h2>
          <p>${posts.length} ${posts.length === 1 ? 'post' : 'posts'} · newest first</p>
        </div>
        <a class="button ghost small" href="/board" target="_blank" rel="noopener">Open public board</a>
      </div>
      <div class="board-admin-list">
        ${posts.length ? postCards : '<div class="empty-state"><h3>No bulletins yet</h3><p>Publish the first announcement using the form above.</p></div>'}
      </div>
    </section>`;

  return renderAdminPageFrame({
    title: 'Bulletin board',
    csrf,
    active: 'board',
    refreshHref: '/admin/board',
    content,
  });
}

function renderAdminActivityPage({ csrf, entries, total, category, query, listError }) {
  const filterOptions = Object.entries(ACTIVITY_CATEGORY_LABELS).map(([value, label]) => `<option value="${value}"${category === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');

  const rows = entries.map((entry) => {
    const student = entry.student;
    const actor = entry.admin
      ? `Admin · ${entry.admin}`
      : student
        ? `${student.name || 'Student'} · ${student.id || ''}`
        : 'Visitor';
    const context = [
      entry.code ? `Code ${entry.code}` : '',
      entry.title || '',
      entry.detail || '',
    ].filter(Boolean).join(' · ');
    return `<tr>
      <td class="activity-time"><span>${escapeHtml(relativeTime(entry.at))}</span><small>${escapeHtml(formatDateTime(entry.at))}</small></td>
      <td><span class="activity-type activity-${escapeHtml(activityCategory(entry.type))}">${escapeHtml(activityLabel(entry.type))}</span></td>
      <td>${escapeHtml(actor)}</td>
      <td><span class="ip-pill">${escapeHtml(entry.ip || 'unknown')}</span></td>
      <td class="activity-detail">${escapeHtml(context || '—')}</td>
    </tr>`;
  }).join('');

  const content = `
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Activity log</p>
      <h1>Every action, in order.</h1>
      <p class="hero-copy">Recordings, player visits, moderation decisions, sign-ins, blocks, and administrator changes are recorded with the IP address and account involved. Showing <strong>${entries.length}</strong> of the latest ${total} events.</p>
    </section>

    ${listError ? `<p class="alert alert-warn" role="alert">${escapeHtml(listError)}</p>` : ''}

    <section class="panel">
      <div class="toolbar toolbar-stack">
        <div>
          <h2>Recent activity</h2>
          <p>Encrypted at rest and visible only to administrators</p>
        </div>
        <form class="activity-filter" method="get" action="/admin/activity" role="search">
          <select name="category" aria-label="Activity category">${filterOptions}</select>
          <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search IP, admin, name, code…" autocomplete="off">
          <button class="button small" type="submit">Filter</button>
        </form>
      </div>
      <div class="table-wrap">
        ${entries.length ? `<table class="admin-table activity-table">
          <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>IP address</th><th>Details</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : `<div class="empty-state">
          <div class="empty-orb" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 7v5l3 2M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0Z"/></svg>
          </div>
          <h3>No matching activity</h3>
          <p>Try another category or clear the search.</p>
          <a class="button ghost small" href="/admin/activity">Show all activity</a>
        </div>`}
      </div>
    </section>`;

  return renderAdminPageFrame({
    title: 'Activity log',
    csrf,
    active: 'activity',
    refreshHref: '/admin/activity',
    content,
  });
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
  const moderation = moderationFor(meta);
  const quality = moderation.quality;
  const student = recordingStudent(meta);
  const reviewFilter = moderation.status === 'pending'
    ? 'review'
    : moderation.status === 'hidden'
      ? 'hidden'
      : moderation.status === 'flagged'
        ? 'flagged'
        : 'all';
  const search = escapeHtml([
    title,
    code,
    student && student.name,
    student && student.id,
    student && student.grade,
    moderation.status,
  ].filter(Boolean).join(' ').toLowerCase());
  const confirmText = `Delete &quot;${escapeHtml(title)}&quot;? This permanently removes the audio and cannot be undone.`;

  return `<article class="recording" data-search="${search}">
    <div class="recording-main">
      <div class="recording-top">
        <h3 class="recording-title">${escapeHtml(title)}</h3>
        <span class="badge ${expired ? 'badge-expired' : 'badge-active'}">${expired ? 'Expired' : 'Active'}</span>
        ${moderationBadge(meta)}
        ${qualityBadge(quality)}
      </div>
      <p class="recording-identity">${renderStudentIdentity(meta)}</p>
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
      <a class="button ghost small" href="/admin/screening?filter=${reviewFilter}&q=${encodeURIComponent(code)}">Review</a>
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
  const needsReview = recordings.filter((meta) => moderationFor(meta).status === 'pending').length;
  const poorQuality = recordings.filter((meta) => {
    const quality = moderationFor(meta).quality;
    return quality && Number(quality.score) < 60;
  }).length;
  const rows = recordings.map((meta) => renderAdminRecordingRow(meta, csrf)).join('');

  const statusMessages = {
    deleted: 'The recording was deleted.',
    missing: 'That recording was already gone.',
    error: 'The recording could not be deleted. Please try again.',
  };

  const content = `
    <section class="admin-hero">
      <p class="eyebrow"><span class="eyebrow-dot"></span> Admin console</p>
      <h1>Every voice note.</h1>
      <p class="hero-copy">Listen to any recording stored on this server, review its identity and quality score, or remove it permanently. Storage: <strong>${escapeHtml(storageLabel)}</strong>.</p>
      <div class="stats stats-five">
        <div class="stat"><span>Total notes</span><strong>${recordings.length}</strong></div>
        <div class="stat"><span>Active</span><strong>${active}</strong></div>
        <div class="stat"><span>Needs review</span><strong>${needsReview}</strong></div>
        <div class="stat"><span>Poor quality</span><strong>${poorQuality}</strong></div>
        <div class="stat"><span>Play time</span><strong>${escapeHtml(formatDuration(totalDuration))}</strong></div>
      </div>
    </section>

    ${renderAdminStatus(status, statusMessages)}
    ${listError ? `<p class="alert alert-warn" role="alert">${escapeHtml(listError)}</p>` : ''}

    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Recordings</h2>
          <p id="visibleCount" data-total="${recordings.length}">${recordings.length} ${recordings.length === 1 ? 'note' : 'notes'} · ${escapeHtml(formatBytes(totalBytes))} audio</p>
        </div>
        <label class="search">
          <span class="sr-only">Search recordings</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="adminSearch" type="search" placeholder="Search name, number, title, or code" autocomplete="off">
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
    </section>`;

  return renderAdminPageFrame({
    title: 'Recordings',
    csrf,
    active: 'dashboard',
    refreshHref: '/admin/dashboard',
    content,
  });
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
