# EchoTag

Record a voice note in the browser, get a QR code, and let anyone play it from their phone. No app, no password, no database. Students sign in with their school details before recording, everyone can read the public bulletin board, and administrators can screen audio, manage bulletins, block abusive connections, and review an activity log.

**Live:** https://echotag-vert.vercel.app  
**Repository:** https://github.com/tremtem015-wq/echotag

The QR code encodes a short link (`/p/<code>`) to a mobile-friendly player. The audio itself lives in storage, not inside the QR code.

## Run it locally

Requires Node.js 20.12 or newer.

```bash
npm install
node server.js
```

Then open **http://localhost:3000**.

> On Windows PowerShell, `npm` may be blocked by the script execution policy. Use `npm.cmd install` or run `node server.js` after installing.

Before the recorder unlocks, enter a full name, choose a grade (`M2` or `G8`), and select a number (เลขที่, 1–34) on a separate sign-in page. Submitting the form creates a signed, `HttpOnly` student session that lasts 12 hours; the recorder and upload routes reject requests without it, so the identity fields are no longer trusted from the client. A warning above the name field explains that fake, impersonating, or inappropriate names can lead to a block. The header language menu switches the public pages between English and Thai.

The **Bulletin board** at `/board` is readable by everyone. Only administrators can publish or remove posts. An **App view** button in the header switches any public page into a phone-style shell with a fixed bottom navigation bar for sign-in, recording, and bulletins; the choice is remembered in `localStorage`.

Click the mic, allow microphone access, record, stop, preview, add a title if you like, and create the QR code. The result screen lets you download the QR as a PNG, copy the link, open the player, or delete the recording.

Local recordings are stored in `data/recordings/` as an audio file plus a small JSON sidecar. Dynamic admins, IP blocks, bulletin posts, and the activity log live in `data/state/` and `data/activity/`, encrypted at rest.

## Admin console

The admin console lives at **`/admin`**. It lists every recording in the connected storage adapter, plays any of them, and can permanently delete a note. It is disabled until a session secret and at least one admin account are set:

| Variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Primary admin username. |
| `ADMIN_PASSWORD_HASH` | scrypt password hash for the primary admin, never a plaintext password. |
| `ADMIN_SESSION_SECRET` | Random secret (32+ characters) used to sign session cookies and CSRF tokens. |
| `ADMIN_USERS` | Optional additional accounts as comma- or newline-separated `username:scrypt-hash` pairs. |

Generate the primary account with:

```bash
npm run admin:credentials -- --write
```

The script prints the password once and writes a private copy to `.secrets/admin-credentials.txt` (ignored by git). Put the username, hash, and session secret into `.env` locally or into the Vercel project environment. Adding an entry to `ADMIN_USERS` creates another login without changing the primary account. Changing `ADMIN_SESSION_SECRET` immediately invalidates every existing admin session.

Security properties:

- Only a signed, `HttpOnly`, `SameSite=Strict` session cookie grants access. Admin sessions expire after 8 hours; student sessions use a separate `SameSite=Lax` cookie and expire after 12 hours.
- Passwords are verified with scrypt and timing-safe comparisons. No plaintext password fallback exists.
- Every state-changing admin request requires a signed session plus a CSRF token. Login CSRF tokens are additionally bound to an `HttpOnly`, `SameSite=Strict` cookie; if a browser drops that cookie, a same-origin request with a valid signed token is still accepted.
- Cross-origin request headers are logged as a warning and treated as defense-in-depth. The signed session, CSRF token, and `SameSite=Strict` cookies are the enforced checks, so reverse proxies and in-app browsers do not lock admins out.
- Sign-in is rate-limited to 8 attempts per IP per 15 minutes, and failures return a generic message.
- Admin pages send `Cache-Control: no-store`, a strict Content Security Policy, `X-Frame-Options: DENY`, `noindex`, and related hardening headers.
- Delete tokens for public recordings are never exposed in the admin console; admins delete through the authenticated route instead.
- Admin playback can still play an expired note that has not yet been swept, so it can be reviewed before cleanup.

### Screening and moderation

The **Screening** page groups recordings by review state and highlights poor-quality audio before anyone else hears it:

- Every upload includes lightweight quality metrics from the browser (average level, peak, silence, clipping).
- A score below **60/100** is marked **review required**.
- A score below **25/100** is automatically **hidden** from public playback.
- Admins can **approve**, **hide**, or **flag** a recording and leave a short review note. Hidden and flagged recordings remain visible in the console but are removed from the public player and media routes.
- The dashboard shows **Needs review** and **Poor quality** counts, plus moderation and quality badges on each recording.

### Active users and IP blocks

The **Active users** page lists connections seen in the last few minutes, including their **IP address** and current page. Blocking an IP requires a written reason. While blocked:

- The recorder, player, QR PNG, media, upload, owner-delete, and presence routes return a blocked notice that includes the administrator's reason.
- The `/admin` console stays reachable, so an administrator cannot lock themselves out.
- Any active recording session is stopped by the client when the block is detected.
- Blocks can be removed from the same page. Each block and unblock is written to the activity log.

### Administrator management

The **Administrators** page lists the built-in accounts from `ADMIN_USERNAME` / `ADMIN_USERS` and any accounts added from the console. New administrators get their own scrypt-hashed password and can sign in immediately. Built-in accounts can only be removed when they are not the account currently signed in; the console never lets the last active account delete itself.

### Bulletin board

The **Bulletin board** page at `/admin/board` publishes announcements to the public `/board` page. Posts are limited to 50, newest first, with a title (up to 120 characters) and message (up to 4,000 characters). Only administrators can add or remove posts, and every change is recorded in the activity log.

### Activity log

The **Activity log** records uploads, public plays, moderation decisions, IP blocks and unblocks, administrator additions and removals, student sign-ins and sign-outs, bulletin posts and removals, and admin sign-ins. Entries include the time, category, IP address where relevant, and a description, and can be filtered by category or searched.

### Encrypted moderation state

Dynamic admins, IP blocks, bulletin posts, activity entries, and stored student identity are encrypted with **AES-256-GCM** using a key derived from `ADMIN_SESSION_SECRET`. This keeps them unreadable in Blob storage, the private Supabase bucket, or on disk. The trade-off: rotating `ADMIN_SESSION_SECRET` also makes existing dynamic admins, blocks, bulletins, activity history, and student identity unreadable, and invalidates active student and admin sessions. Existing recordings still play, but their identity chips and moderation state may need to be recreated.

## Scanning from a phone

1. Keep your computer and phone on the same Wi-Fi.
2. Start the server and leave it running.
3. Create a note on your computer at `localhost:3000`.
4. Scan the QR code with your phone's camera.

The server automatically puts its detected LAN address (something like `http://192.168.1.20:3000`) into the QR code, because `localhost` on your phone points at the phone itself.

If your computer has several network adapters (VPN, virtual machines), the detected address may be wrong. Open **QR link settings** on the result screen, paste the right base address, press **Apply**, and download the updated QR.

On Windows, allow Node.js through the firewall when prompted so phones can reach port 3000. The site is only reachable on your local network unless you deploy it or use a tunnel.

## Microphone + HTTPS

Browsers only allow microphone access on secure origins:

- `http://localhost` — allowed (good for recording on the computer running the server)
- `https://your-site.example.com` — allowed
- `http://192.168.1.20:3000` — **not allowed** for recording, but playback works fine

So the usual local flow works without HTTPS: record on your computer at `localhost`, scan with your phone over the LAN. If you want to record from a phone or share the site publicly, deploy it with HTTPS (Vercel does this automatically).

Autoplay is also a browser decision. The player tries to start on its own; if the browser blocks sound, it shows a clear "tap to play" prompt, and tapping anywhere on the card starts playback.

## Deploy on Vercel

Vercel's serverless filesystem is temporary, so production uses **Supabase Storage** (recommended) or **Vercel Blob** (legacy fallback). The app picks storage in this order: Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, then Vercel Blob when a Blob store is connected (`BLOB_STORE_ID` with OIDC, or `BLOB_READ_WRITE_TOKEN`), then local disk for development.

Supabase mode uses two buckets, created automatically on first use:

- `echotag-media` — public bucket for audio (`audio/<code>.<ext>`); playback redirects to its public CDN URL.
- `echotag-data` — private bucket for encrypted state, recording metadata, and activity entries (`state/`, `meta/`, `activity/`). Only the service-role key can read it.

1. Push this repository to GitHub.
2. In Vercel, choose **Add New → Project**, import the repository, and deploy. No build command is needed.
3. Open **Storage** (Marketplace) and add **Supabase** on the free plan, or connect an existing Supabase project. This sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for Production, Preview, and Development. You can also set them manually in **Settings → Environment Variables**.
4. Redeploy (or trigger a new deployment) so the function receives the new environment variables.
5. Optional but recommended: add a `CRON_SECRET` environment variable (any long random string). The included daily cron at `/api/cron/sweep` uses it to delete expired recordings.
6. Add `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET` from `npm run admin:credentials -- --write`. Set them for Production (and Preview, if you test there), then redeploy.
7. Optional: set `PUBLIC_BASE_URL` to your production URL, e.g. `https://echotag.vercel.app`. If unset, the app derives it from the incoming request.

After deployment, open `/admin`, sign in, and verify that playback and deletion work. The admin routes are included in `vercel.json` rewrites so Vercel sends them to the Express function.

The deployment includes `api/index.js` (the serverless entrypoint), `vercel.json` (routing, function limits, daily cleanup cron), and static files served from `public/`.

### Vercel limits

- Function request bodies are capped at about 4.5 MB. On Vercel the app defaults to **180 seconds** and **4 MB** per recording, with the browser recording at 96 kbps.
- Override with `MAX_RECORDING_SECONDS` and `MAX_UPLOAD_MB`, but keep uploads below the Vercel body limit. At 96 kbps, 180 seconds is roughly 2.2 MB.
- Rate limits are in memory, so they are best-effort across serverless instances.
- Supabase's free plan includes 1 GB of storage and 5 GB of egress per month. Audio playback is served from its CDN and does not pass through the Vercel function.
- The browser still needs a tap to play when autoplay is blocked; that is a browser policy, not a bug.

### Migrating old Blob recordings

Recordings created before the Supabase migration stay in the old Blob store. Once Blob access is available again, copy them over with:

```bash
node --env-file=.env.local scripts/migrate-blob-to-supabase.js --dry-run
node --env-file=.env.local scripts/migrate-blob-to-supabase.js
```

The script needs `BLOB_READ_WRITE_TOKEN` plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. It rewrites each recording's `audioUrl` to the new Supabase public URL. Existing Supabase metadata makes the script skip that recording, so it is safe to rerun; pass `--recordings-overwrite` to replace existing metadata. Activity entries are copied by their unique filenames. Encrypted state documents are only copied when `--state` is passed, and an existing state document is never replaced. Use `--only=meta,audio,state,activity` to limit a run.

### Deploy with the CLI instead

```bash
npx vercel
npx vercel --prod
```

After the first deploy, connect Supabase from the Vercel Marketplace (or set the two Supabase variables manually) and redeploy. Local `npx vercel dev` can also use the same Supabase project when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are in `.env.local`; the app loads `.env` automatically, or start it with `node --env-file=.env.local server.js`.

## Configuration

Copy `.env.example` to `.env`, or set environment variables in your shell or Vercel project:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the local server listens on. |
| `PUBLIC_BASE_URL` | auto | Address encoded into QR codes. Set this when deploying behind a custom domain. |
| `RETENTION_DAYS` | `30` | Days before recordings are deleted automatically. `0` keeps them until deleted. |
| `MAX_RECORDING_SECONDS` | `300` local / `180` Vercel | Maximum recording length. |
| `MAX_UPLOAD_MB` | `25` local / `4` Vercel | Maximum upload size in megabytes. |
| `SUPABASE_URL` | unset | Supabase project URL. When this and the service-role key are set, Supabase Storage is used first. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Supabase service-role key. Server-only; never expose it to the browser. |
| `SUPABASE_MEDIA_BUCKET` | `echotag-media` | Public bucket for audio. Created automatically when missing. |
| `SUPABASE_DATA_BUCKET` | `echotag-data` | Private bucket for encrypted state, metadata, and activity entries. Created automatically when missing. |
| `BLOB_READ_WRITE_TOKEN` | unset | Legacy Vercel Blob credential for local development or token mode. Only used when Supabase is not configured. |
| `BLOB_STORE_ID` | unset | Legacy Blob store ID set automatically when a Blob store is connected with OIDC. Only used when Supabase is not configured. |
| `CRON_SECRET` | unset | Bearer token required by `/api/cron/sweep`. |
| `ADMIN_USERNAME` | unset | Username for `/admin`. Admin stays disabled until at least one account and a session secret are valid. |
| `ADMIN_PASSWORD_HASH` | unset | scrypt hash generated by `npm run admin:credentials`. Never a plaintext password. |
| `ADMIN_USERS` | unset | Optional extra admin accounts as `username:scrypt-hash` pairs, comma- or newline-separated. |
| `ADMIN_SESSION_SECRET` | unset | 32+ character random secret that signs admin session and CSRF tokens and derives the encryption key for dynamic admins, IP blocks, activity entries, and stored student identity. |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so rate limiting and URLs use the forwarded address. Always on for Vercel. |

Example `.env`:

```dotenv
PORT=3000
PUBLIC_BASE_URL=https://voice.example.com
RETENTION_DAYS=30
MAX_RECORDING_SECONDS=300
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt$16384$8$1$...
ADMIN_SESSION_SECRET=replace-with-a-long-random-string
```

## Other hosting

EchoTag is a normal Express app and can also run on a host with a persistent disk:

- Mount persistent storage at `data/` and leave the Supabase and Blob variables unset.
- Serve it over HTTPS. You need this to record from phones.
- Set `PUBLIC_BASE_URL` to the public HTTPS URL so QR codes work off your local network.
- If you put nginx or Caddy in front, set `TRUST_PROXY=1`.

Example Caddyfile:

```caddyfile
voice.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Things to know before opening it to the public:

- Links are unlisted, not private. Anyone with the link or QR code can listen; short codes are random but not a security boundary.
- The admin console can hear and delete every stored note. Keep its credentials private, use HTTPS, and rotate `ADMIN_SESSION_SECRET` if a session may have leaked.
- There are no end-user accounts. The delete token is only available on the result screen right after creating a note, so save it if you want to delete later. Retention handles eventual cleanup.
- Local uploads are capped at 25 MB and rate-limited to 30 recordings per IP per 10 minutes. Limits are kept in memory and reset on restart.

## How it works

```
public/          Player/admin styles/scripts, data-entry and recorder assets, language files
views/           Data-entry and recording pages served through the server-side block gate
server.js        Express app: upload, storage, QR PNG, play page, audio delivery, admin auth
api/index.js     Vercel serverless entrypoint
vercel.json      Vercel rewrites, function limits, daily cleanup cron
scripts/         Admin credential generator
data/recordings/ Local audio + metadata (auto-created, ignored by git)
data/state/      Encrypted dynamic admins and IP blocks (auto-created, ignored by git)
data/activity/   Encrypted activity log (auto-created, ignored by git)
.secrets/        Generated admin credentials (ignored by git)
```

- Storage is behind a small adapter with three modes: Supabase Storage (preferred; public `echotag-media` for audio, private `echotag-data` for state/meta/activity), Vercel Blob (`echotag/audio/...` and `echotag/meta/...`, legacy fallback), or local disk.
- `/` is the data-entry screen and `/record` is the voice recorder. A valid identity is saved for the browser tab, so the recorder opens only after the data-entry step, like a sign-in screen. The header language menu switches the public pages between English and Thai.
- In Blob mode, recording metadata and state documents are written as immutable, timestamped versions discovered with `list`, so moderation, blocks, and admin changes take effect immediately instead of waiting for a CDN copy to expire. In Supabase mode, state, metadata, and activity entries use fixed object keys and are overwritten in place; short in-memory caches (5–30 seconds) limit storage requests on serverless instances.
- The browser records with `MediaRecorder`, choosing Opus/WebM, AAC/MP4, or Ogg depending on the browser.
- Uploads must include a valid student identity and are scored from the browser's audio-level samples before storage. A server-side moderation record controls whether the public player and media routes expose the note.
- The recorder and player send a lightweight presence heartbeat so the console can list active IP addresses. Blocks are checked on public page, API, QR, and media routes.
- The server sniffs the uploaded bytes, validates the format, and stores the audio with a short random code.
- QR codes are generated server-side with the [`qrcode`](https://www.npmjs.com/package/qrcode) package and point at `/p/<code>`.
- In Supabase and Blob modes, the player and admin audio route redirect to the storage CDN. Locally, `/media/<code>` and `/admin/audio/<code>` stream the file with HTTP range support so seeking works.
- Peak data captured during recording is used to draw the waveform on the player.
- Expired recordings are removed lazily when opened, swept on startup and every six hours locally, and swept daily on Vercel by the cron job.

## Scripts

```bash
node server.js           # start the local server
node --watch server.js   # restart on file changes
npm run admin:credentials -- --write   # generate admin credentials
npm run deploy           # deploy to Vercel production (requires Vercel CLI)
```

`npm start` and `npm run dev` do the same as the first two.
