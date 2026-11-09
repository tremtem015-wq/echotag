#!/usr/bin/env node
'use strict';

/**
 * Copies recordings and encrypted state from a legacy Vercel Blob store into
 * Supabase Storage.
 *
 * Use this after Blob access resumes (for example when a Hobby quota resets)
 * and when both sets of credentials are available:
 *
 *   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-blob-to-supabase.js --dry-run
 *   node --env-file=.env.local scripts/migrate-blob-to-supabase.js
 *   node --env-file=.env.local scripts/migrate-blob-to-supabase.js --state
 *
 * Recordings are copied only when their metadata does not already exist in
 * Supabase, so the script is safe to rerun. Encrypted state documents are
 * skipped unless --state is passed, because current Supabase state may be
 * newer than the old Blob copy. Activity entries are appended by unique name.
 */

const path = require('node:path');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read .env:', err.message);
  }
}

const { list } = require('@vercel/blob');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const copyState = args.has('--state');
const overwriteRecordings = args.has('--recordings-overwrite');
const onlyArg = process.argv.slice(2).find((value) => value.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((v) => v.trim()).filter(Boolean)) : null;

const BLOB_TOKEN = (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MEDIA_BUCKET = (process.env.SUPABASE_MEDIA_BUCKET || 'echotag-media').trim();
const DATA_BUCKET = (process.env.SUPABASE_DATA_BUCKET || 'echotag-data').trim();

const BLOB_META_PREFIX = 'echotag/meta/';
const BLOB_AUDIO_PREFIX = 'echotag/audio/';
const BLOB_STATE_PREFIX = 'echotag/state/';
const BLOB_ACTIVITY_PREFIX = 'echotag/activity/';
const CODE_PATTERN = /^[a-z0-9]{6,16}$/;

if (!BLOB_TOKEN) {
  console.error('BLOB_READ_WRITE_TOKEN is required.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabaseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

function wanted(section) {
  return !only || only.has(section);
}

function encodeKey(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
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

async function listSupabase(bucket, prefix) {
  const names = new Set();
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...supabaseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset }),
    });
    if (!response.ok) {
      throw new Error(`Supabase list failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
    }
    const entries = await response.json();
    for (const entry of entries) {
      if (entry && entry.name) names.add(`${prefix}${entry.name}`);
    }
    if (entries.length < 1000) break;
  }
  return names;
}

async function downloadBlob(blob) {
  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Blob download failed for ${blob.pathname} (${response.status}). Is Blob access restored?`);
  }
  return response;
}

async function putSupabase(bucket, key, body, contentType) {
  if (dryRun) return;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeKey(key)}`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders,
      'Content-Type': contentType || 'application/octet-stream',
      'cache-control': key.startsWith('audio/') ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-upsert': 'true',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Supabase upload failed for ${bucket}/${key} (${response.status}): ${(await response.text()).slice(0, 160)}`);
  }
}

function newestFirst(a, b) {
  return (Date.parse(b.uploadedAt) || 0) - (Date.parse(a.uploadedAt) || 0);
}

function latestByStem(blobs, prefix) {
  const latest = new Map();
  for (const blob of blobs) {
    if (!blob.pathname.startsWith(prefix) || !blob.pathname.endsWith('.json')) continue;
    const stem = blob.pathname.slice(prefix.length, -'.json'.length);
    const name = stem.split('.')[0];
    const current = latest.get(name);
    if (!current || newestFirst(blob, current) < 0) latest.set(name, blob);
  }
  return latest;
}

function audioCodeFor(pathname) {
  if (!pathname.startsWith(BLOB_AUDIO_PREFIX)) return null;
  const filename = pathname.slice(BLOB_AUDIO_PREFIX.length);
  const match = /^([a-z0-9]{6,16})(\.[a-z0-9]+)$/i.exec(filename);
  return match ? { code: match[1], filename } : null;
}

async function main() {
  console.log(`Blob -> Supabase migration${dryRun ? ' (dry run)' : ''}`);
  console.log(`  Media bucket: ${MEDIA_BUCKET}`);
  console.log(`  Data bucket:  ${DATA_BUCKET}`);

  const [metaBlobs, audioBlobs, stateBlobs, activityBlobs] = await Promise.all([
    wanted('meta') || wanted('audio') ? listAllBlobs(BLOB_META_PREFIX) : [],
    wanted('meta') || wanted('audio') ? listAllBlobs(BLOB_AUDIO_PREFIX) : [],
    wanted('state') ? listAllBlobs(BLOB_STATE_PREFIX) : [],
    wanted('activity') ? listAllBlobs(BLOB_ACTIVITY_PREFIX) : [],
  ]);

  const [existingMeta, existingAudio, existingState, existingActivity] = await Promise.all([
    listSupabase(DATA_BUCKET, 'meta/'),
    listSupabase(MEDIA_BUCKET, 'audio/'),
    listSupabase(DATA_BUCKET, 'state/'),
    listSupabase(DATA_BUCKET, 'activity/'),
  ]);

  const latestMeta = latestByStem(metaBlobs, BLOB_META_PREFIX);
  const audioByCode = new Map();
  for (const blob of audioBlobs) {
    const parsed = audioCodeFor(blob.pathname);
    if (parsed) audioByCode.set(parsed.code, { ...parsed, blob });
  }

  let copiedRecordings = 0;
  let skippedRecordings = 0;
  let copiedAudio = 0;
  let copiedState = 0;
  let copiedActivity = 0;

  if (wanted('meta') || wanted('audio')) {
    for (const [code, metaBlob] of latestMeta) {
      if (!CODE_PATTERN.test(code)) continue;
      const metaKey = `meta/${code}.json`;
      if (existingMeta.has(metaKey) && !overwriteRecordings) {
        skippedRecordings += 1;
        continue;
      }

      const metaResponse = await downloadBlob(metaBlob);
      const meta = await metaResponse.json().catch(() => null);
      if (!meta || meta.code !== code || !meta.mime) {
        console.warn(`  skip malformed metadata: ${code}`);
        continue;
      }

      const audio = audioByCode.get(code);
      if (!audio) {
        console.warn(`  skip ${code}: audio file not found in Blob`);
        continue;
      }

      if (wanted('audio') && (!existingAudio.has(`audio/${audio.filename}`) || overwriteRecordings)) {
        const audioResponse = await downloadBlob(audio.blob);
        await putSupabase(MEDIA_BUCKET, `audio/${audio.filename}`, Buffer.from(await audioResponse.arrayBuffer()), meta.mime);
        copiedAudio += 1;
      }

      meta.audioUrl = `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/audio/${encodeKey(audio.filename)}`;
      if (wanted('meta')) {
        await putSupabase(DATA_BUCKET, metaKey, Buffer.from(JSON.stringify(meta, null, 2)), 'application/json');
        copiedRecordings += 1;
      }
    }
  }

  if (copyState && wanted('state')) {
    for (const [name, blob] of latestByStem(stateBlobs, BLOB_STATE_PREFIX)) {
      const key = `state/${name}.json`;
      if (existingState.has(key)) {
        console.log(`  keep existing state/${name}.json`);
        continue;
      }
      const response = await downloadBlob(blob);
      await putSupabase(DATA_BUCKET, key, Buffer.from(await response.arrayBuffer()), 'application/json');
      copiedState += 1;
    }
  }

  if (wanted('activity')) {
    for (const blob of activityBlobs) {
      if (!blob.pathname.endsWith('.json')) continue;
      const filename = blob.pathname.slice(BLOB_ACTIVITY_PREFIX.length);
      const key = `activity/${filename}`;
      if (existingActivity.has(key)) continue;
      const response = await downloadBlob(blob);
      await putSupabase(DATA_BUCKET, key, Buffer.from(await response.arrayBuffer()), 'application/json');
      copiedActivity += 1;
    }
  }

  console.log('');
  console.log(`Recordings copied: ${copiedRecordings} (skipped ${skippedRecordings} already present)`);
  console.log(`Audio files copied: ${copiedAudio}`);
  console.log(`State documents copied: ${copiedState}${copyState ? '' : ' (pass --state to copy)'}`);
  console.log(`Activity entries copied: ${copiedActivity}`);
  console.log(dryRun ? 'Dry run complete. Nothing was uploaded.' : 'Migration complete.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
