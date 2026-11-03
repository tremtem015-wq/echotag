#!/usr/bin/env node
'use strict';

/**
 * Generates the environment variables for the EchoTag admin console.
 *
 * Usage:
 *   node scripts/generate-admin-credentials.js [username] [--write]
 *
 * The password is shown once. When --write is used, a copy is saved to
 * .secrets/admin-credentials.txt, which is ignored by git.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const args = process.argv.slice(2);
const write = args.includes('--write');
const positional = args.filter((arg) => !arg.startsWith('--'));
const username = (positional[0] || 'admin').trim();

if (!username || username.length > 80 || /[\u0000-\u001f\u007f]/.test(username)) {
  console.error('Username must be 1-80 characters with no control characters.');
  process.exit(1);
}

const password = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT_KEYLEN, {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAXMEM,
});
const passwordHash = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
const sessionSecret = crypto.randomBytes(48).toString('base64url');

const check = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT_KEYLEN, {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAXMEM,
});
if (!crypto.timingSafeEqual(check, key)) {
  console.error('Password hash self-check failed.');
  process.exit(1);
}

const output = [
  '# EchoTag admin credentials. Keep this file private.',
  `ADMIN_USERNAME=${username}`,
  `ADMIN_PASSWORD=${password}`,
  `ADMIN_PASSWORD_HASH=${passwordHash}`,
  `ADMIN_SESSION_SECRET=${sessionSecret}`,
  '',
].join('\n');

if (write) {
  const secretsDir = path.join(__dirname, '..', '.secrets');
  const target = path.join(secretsDir, 'admin-credentials.txt');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, output, { mode: 0o600 });
  console.log(`Wrote admin credentials to ${target}`);
  console.log('');
}

console.log(output);
console.log('Store the password now. It cannot be recovered from the hash.');
console.log('Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET in your environment.');
