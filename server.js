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

function audioPathFor(meta) {
  const ext = ALLOWED_EXTS.has(meta.ext) ? meta.ext : AUDIO_MIME_EXT[meta.mime] || '.webm';
  return path.join(DATA_DIR, `${meta.code}${ext}`);
}

function blobMetaPathname(code) {
  return `${BLOB_META_PREFIX}${code}.json`;
}

function blobAudioPathname(meta) {
  const ext = ALLOWED_EXTS.has(meta.ext) ? meta.ext : AUDIO_MIME_EXT[meta.mime] || '.webm';
  return `${BLOB_AUDIO_PREFIX}${meta.code}${ext}`;
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

function createLimiter({ limit, windowMs, message }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
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
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

const uploadLimiter = createLimiter({
  limit: 30,
  windowMs: 10 * 60 * 1000,
  message: 'Too many recordings from this device. Please wait a few minutes.',
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

    const filePath = audioPathFor(meta);
    const stat = await fsp.stat(filePath);
    const size = stat.size;
    const baseHeaders = {
      'Content-Type': meta.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename="${APP_NAME.toLowerCase()}-${meta.code}${meta.ext}"`,
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
      fs.createReadStream(filePath, { start, end })
        .on('error', next)
        .pipe(res);
      return;
    }

    res.status(200).set({ ...baseHeaders, 'Content-Length': String(size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', next)
      .pipe(res);
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
  </main>
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
    console.log('');
  });

  sweepExpired().catch((err) => console.warn('Expiry sweep failed:', err.message));
  const sweepTimer = setInterval(() => {
    sweepExpired().catch((err) => console.warn('Expiry sweep failed:', err.message));
  }, 6 * 60 * 60 * 1000);
  sweepTimer.unref();
}
