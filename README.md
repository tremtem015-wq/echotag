# EchoTag

Record a voice note in the browser, get a QR code, and let anyone play it from their phone. No app, no account, no database.

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

Click the mic, allow microphone access, record, stop, preview, add a title if you like, and create the QR code. The result screen lets you download the QR as a PNG, copy the link, open the player, or delete the recording.

Local recordings are stored in `data/recordings/` as an audio file plus a small JSON sidecar.

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

- Only a signed, `HttpOnly`, `SameSite=Strict` session cookie grants access. Sessions expire after 8 hours.
- Passwords are verified with scrypt and timing-safe comparisons. No plaintext password fallback exists.
- Every state-changing admin request requires a signed session plus a CSRF token. Login CSRF tokens are additionally bound to an `HttpOnly`, `SameSite=Strict` cookie; if a browser drops that cookie, a same-origin request with a valid signed token is still accepted.
- Cross-origin request headers are logged as a warning and treated as defense-in-depth. The signed session, CSRF token, and `SameSite=Strict` cookies are the enforced checks, so reverse proxies and in-app browsers do not lock admins out.
- Sign-in is rate-limited to 8 attempts per IP per 15 minutes, and failures return a generic message.
- Admin pages send `Cache-Control: no-store`, a strict Content Security Policy, `X-Frame-Options: DENY`, `noindex`, and related hardening headers.
- Delete tokens for public recordings are never exposed in the admin console; admins delete through the authenticated route instead.
- Admin playback can still play an expired note that has not yet been swept, so it can be reviewed before cleanup.

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

Vercel's serverless filesystem is temporary, so production recordings are stored in **Vercel Blob**. The app detects a connected Blob store (`BLOB_STORE_ID` with OIDC, or `BLOB_READ_WRITE_TOKEN`) and switches storage automatically; without either, local development uses the filesystem.

1. Push this repository to GitHub.
2. In Vercel, choose **Add New → Project**, import the repository, and deploy. No build command is needed.
3. In the project, open **Storage → Create → Blob**, create a store, and connect it to the project. The CLI connects it with OIDC by default, which sets `BLOB_STORE_ID`; token mode with `BLOB_READ_WRITE_TOKEN` also works.
4. Redeploy (or trigger a new deployment) so the function receives the new environment variable.
5. Optional but recommended: add a `CRON_SECRET` environment variable (any long random string). The included daily cron at `/api/cron/sweep` uses it to delete expired recordings.
6. Add `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET` from `npm run admin:credentials -- --write`. Set them for Production (and Preview, if you test there), then redeploy.
7. Optional: set `PUBLIC_BASE_URL` to your production URL, e.g. `https://echotag.vercel.app`. If unset, the app derives it from the incoming request.

After deployment, open `/admin`, sign in, and verify that playback and deletion work. The admin routes are included in `vercel.json` rewrites so Vercel sends them to the Express function.

The deployment includes `api/index.js` (the serverless entrypoint), `vercel.json` (routing, function limits, daily cleanup cron), and static files served from `public/`.

### Vercel limits

- Function request bodies are capped at about 4.5 MB. On Vercel the app defaults to **180 seconds** and **4 MB** per recording, with the browser recording at 96 kbps.
- Override with `MAX_RECORDING_SECONDS` and `MAX_UPLOAD_MB`, but keep uploads below the Vercel body limit. At 96 kbps, 180 seconds is roughly 2.2 MB.
- Rate limits are in memory, so they are best-effort across serverless instances.
- The browser still needs a tap to play when autoplay is blocked; that is a browser policy, not a bug.

### Deploy with the CLI instead

```bash
npx vercel
npx vercel --prod
```

After the first deploy, connect a Blob store in the Vercel dashboard and redeploy. Local `npx vercel dev` can also use a Blob store if `BLOB_READ_WRITE_TOKEN` is set in `.env.local`.

## Configuration

Copy `.env.example` to `.env`, or set environment variables in your shell or Vercel project:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the local server listens on. |
| `PUBLIC_BASE_URL` | auto | Address encoded into QR codes. Set this when deploying behind a custom domain. |
| `RETENTION_DAYS` | `30` | Days before recordings are deleted automatically. `0` keeps them until deleted. |
| `MAX_RECORDING_SECONDS` | `300` local / `180` Vercel | Maximum recording length. |
| `MAX_UPLOAD_MB` | `25` local / `4` Vercel | Maximum upload size in megabytes. |
| `BLOB_READ_WRITE_TOKEN` | unset | Static Vercel Blob credential for local development or token mode. On Vercel, a connected Blob store can use OIDC instead (`BLOB_STORE_ID`). |
| `BLOB_STORE_ID` | unset | Set automatically when a Blob store is connected with OIDC. Powers Blob storage together with Vercel's OIDC token. |
| `CRON_SECRET` | unset | Bearer token required by `/api/cron/sweep`. |
| `ADMIN_USERNAME` | unset | Username for `/admin`. Admin stays disabled until at least one account and a session secret are valid. |
| `ADMIN_PASSWORD_HASH` | unset | scrypt hash generated by `npm run admin:credentials`. Never a plaintext password. |
| `ADMIN_USERS` | unset | Optional extra admin accounts as `username:scrypt-hash` pairs, comma- or newline-separated. |
| `ADMIN_SESSION_SECRET` | unset | 32+ character random secret that signs admin session and CSRF tokens. |
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

- Mount persistent storage at `data/` and leave `BLOB_READ_WRITE_TOKEN` unset.
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
public/          Recorder UI, player styles, admin console styles and scripts
server.js        Express app: upload, storage, QR PNG, play page, audio delivery, admin auth
api/index.js     Vercel serverless entrypoint
vercel.json      Vercel rewrites, function limits, daily cleanup cron
scripts/         Admin credential generator
data/recordings/ Local audio + metadata (auto-created, ignored by git)
.secrets/        Generated admin credentials (ignored by git)
```

- Storage is behind a small adapter: local file mode, or Vercel Blob mode (`echotag/audio/...` and `echotag/meta/...`).
- The browser records with `MediaRecorder`, choosing Opus/WebM, AAC/MP4, or Ogg depending on the browser.
- The server sniffs the uploaded bytes, validates the format, and stores the audio with a short random code.
- QR codes are generated server-side with the [`qrcode`](https://www.npmjs.com/package/qrcode) package and point at `/p/<code>`.
- In Blob mode, the player reads audio directly from the Blob CDN. Locally, `/media/<code>` streams the file with HTTP range support so seeking works.
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
