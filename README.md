# POD Video Studio

POD Video Studio is an internal desktop application for generating high-fidelity product review videos from product mockup images using the company-approved Muse video generator.

The application allows employees to drag and drop product mockups, select SKUs and categories, preview and edit company-standard prompt templates, and receive validated MP4 videos organized automatically into the SKU media library.

---

## Quick start (what you still need to fill in)

1. `npm install`, then `npm run dev`. With the default `PROVIDER_MODE=mock` the whole workflow runs offline
   (mock provider writes a tiny valid MP4) — no URL or key needed.
2. To test against the real Muse bridge, edit `.env` (dev) or `%APPDATA%\POD Video Studio\.env` (installed app):
   - `PROVIDER_MODE=bridge`
   - `MUSE_PLATFORM_ORIGIN=` exact Muse origin your team uses (compatibility gate, see
     `docs/integration/platform-compatibility.md`)
   - `MUSE_BRIDGE_BASE_URL=` e.g. `http://127.0.0.1:47821` (loopback only — anything else is rejected at startup)
   - `MUSE_BRIDGE_API_KEY=` (or enter it in **Admin → Provider**, stored with DPAPI)
   - `PROMPT_MASTER_PATH=` absolute path to the company-approved Prompt Master V2 `.md`
     (until then the built-in **PLACEHOLDER** template is used and is clearly labelled in the UI)
   - `POD_ADMIN_USERS=` your Windows username(s), required to see the **Admin** screen in the installed app
3. Before the first live run, read the bridge's live `/v1/openapi.json` and adjust
   `src/main/providers/muse/endpoints.ts` (all assumed field names are marked `ASSUMPTION`).
4. Installer: `npm run dist` → `release/POD Video Studio Setup <version>.exe` (unsigned until `CSC_LINK` is set).

## First run (installed app)

The installer ships a patched Muse4AI (`resources/muse4ai`, MIT licence files included) and the company
T-shirt Prompt Master. On start POD Video Studio launches Muse4AI hidden and provisions it: API on this machine
only, a loopback proxy inside Muse4AI (`127.0.0.1:8080`, `MUSE4AI_PROXY_PORT` to change), one Muse account and an
API key stored with DPAPI. The employee only:

1. Installs and opens POD Video Studio → the **Set up Muse** screen appears.
2. Clicks **Sign in to Muse** and signs in to muse.ai with their own account in the window that opens.
3. The screen closes by itself; **Create video** works from then on (also after a restart).

If another, unpatched Muse4AI is already running, the screen offers **Use the bundled version** (quits it and starts
the bundled one; accounts, proxy and keys in `%APPDATA%MuseStudio` are kept).

### Bundled Muse4AI (build machine)

`npm run build:muse4ai` clones the pinned upstream commit (`vendor/muse4ai/UPSTREAM`), applies
`vendor/muse4ai/patches/*.diff`, runs Muse4AI's typecheck and tests, packages it and copies it to
`vendor/muse4ai/dist` (gitignored). `npm run dist` runs it automatically when `dist` is missing.

- `0001-vm-state-unknown.diff` — Muse now reports `vm_state: "UNKNOWN"` for a usable machine; upstream treated it as
  asleep, retried a wake for 20 s and paused the account after 3 tries. Also logs background session-check failures.
- `0002-pod-bootstrap.diff` — `--pod-bootstrap <json>` (API local, loopback proxy, account, key hand-over to a file in
  POD's data folder), `--pod-login` (opens the Muse sign-in window), `pod: true` in `/v1/health`, auto-update off.

To move to a newer Muse4AI: change `commit` in `UPSTREAM`, re-run `npm run build:muse4ai` and fix any patch that no
longer applies (drop 0001 once upstream handles `UNKNOWN`).

### Dev against a hand-run Muse4AI

`.env`: `PROVIDER_MODE=bridge`, `MUSE_PLATFORM_ORIGIN=https://muse.ai`, `MUSE_BRIDGE_BASE_URL=http://127.0.0.1:47821`,
`MUSE_BRIDGE_API_KEY=msk_…` (Muse4AI → Settings → API & agent). In dev POD also manages
`vendor/muse4ai/dist/Muse4AI.exe` when it has been built; delete that folder to manage Muse4AI by hand.

## MVP Definition of Done status (brief §12)

| Item | Status |
|---|---|
| One company-branded Windows installer | Built (NSIS per-user); **unsigned** until `CSC_LINK`/`CSC_KEY_PASSWORD` are provided; default Electron icon (`build/` has a note for the company icon) |
| Upload mockup, SKU, versioned Prompt Master | Done |
| Prompt preview + artwork-preservation checks | Done (generation blocked when checks fail) |
| Exact existing Muse generator, no substitution | Only `MockMuseProvider` and the loopback `RestBridgeMuseProvider` exist |
| Provider compatibility + permitted method approved | **Pending company** — origin, ToS/legal approval |
| One click → at most one generation | Done (single-flight UI + idempotency key + DB unique key) |
| Ambiguous submit never auto-duplicates | Done (SUBMITTING→AMBIGUOUS on crash/timeout; transient poll errors keep RUNNING) |
| MP4 validated, hashed, stored under SKU | Done |
| Metadata survives restart | Done (SQLite + restart recovery) |
| Safe, understandable states/errors | Done |
| No plaintext secrets / secrets in logs | Done (DPAPI fail-closed, log redaction) |
| Loopback-only, authenticated network | Done (POD opens no listener; the bundled Muse4AI's API and proxy listen on 127.0.0.1 only) |
| Tests + SBOM/security scan on release commit | Tests pass locally; CI workflow with audit, SBOM, Gitleaks ready (`.github/workflows/ci.yml`) |
| Signed installer and executable | **Pending company certificate** |
| Pilot on one isolated Windows PC | **Pending** |

---

## Architecture Overview

- **Desktop Framework:** Electron 45 + Node 24 + TypeScript (strict).
- **Renderer UI:** React 19 + Vite 8 via `electron-vite`.
- **Database:** Node.js built-in `node:sqlite` (`DatabaseSync`) in WAL mode.
- **Provider Boundary:** Isolated behind `MuseProvider` contract (`@shared/provider`); defaults to offline `MockMuseProvider` for safe local testing.
- **Security & Secrets:** Windows DPAPI via Electron `safeStorage` (fail-closed, no plaintext fallback).
- **Network Boundary:** Loopback-only networking (`127.0.0.1` / `localhost`).

---

## Environment Configuration

### Which `.env` file is loaded?
- **Development Mode (`npm run dev`):** Reads `.env` from the repository root directory (working directory).
- **Installed Desktop Application (Production):** Reads an optional `.env` file from the user data directory:
  `%APPDATA%\POD Video Studio\.env` (Electron `userData`; the SQLite database `pod-studio.db`,
  `secrets.json` and `logs\` live in the same folder).
  This allows testing and custom configurations on installed desktop builds.
- **Explicit Override:** Pass `envFilePath` to `loadConfig` to load an explicit file path.

### Bridge API Key Storage: Recommended vs Fallback
- **Recommended (Production):** Enter the bridge API key in the **Admin** settings screen. It is encrypted using Windows DPAPI via Electron's `safeStorage` and stored with restrictive permissions (`0o600`).
- **Testing Convenience:** `MUSE_BRIDGE_API_KEY` may be set in `.env` as a fallback when no DPAPI secret has been saved. It is read on-demand in both development and installed mode, is never persisted to the secret store, and is never written to logs or diagnostics.

Copy `.env.example` to `.env` for local development. **Never commit `.env`.**

All URLs and keys are company-supplied and must use placeholders:

| Variable | Default / Format | Description |
|---|---|---|
| `PROVIDER_MODE` | `mock` (`bridge` in an installed app with the bundled Muse4AI) | `mock` (offline, no network) or `bridge` (approved local Muse bridge) |
| `MUSE4AI_PROXY_PORT` | `8080` | Loopback port of the proxy the bundled Muse4AI runs for this machine. |
| `MUSE_SUBMIT_MODE` | `chat` | `chat` = full prompt sent verbatim to Muse via Muse4AI chat (≤ 32000 chars) with the mockup attached; `video` = Muse4AI video job (≤ 4000 chars) |
| `MUSE_PLATFORM_ORIGIN` | `PLACEHOLDER` | Exact HTTPS origin of Muse product (e.g. `https://muse.ai`) |
| `MUSE_BRIDGE_BASE_URL` | `PLACEHOLDER` | Loopback-only bridge base URL (e.g. `http://127.0.0.1:47821`). Trailing slashes are automatically stripped. |
| `MUSE_BRIDGE_API_KEY` | `PLACEHOLDER` | Convenience API key fallback. Admin screen (DPAPI) is recommended for production. |
| `PROMPT_MASTER_PATH` | `PLACEHOLDER` | Optional absolute path to company Prompt Master markdown file. |
| `POD_LIBRARY_ROOT` | `<Documents>/POD_VIDEO_LIBRARY` | Destination folder for SKU video library. |
| `PROMPT_MAX_CHARS` | `32000` | Maximum prompt length enforced by the app; 32000 is also the Muse4AI chat limit (video mode allows 4000). |
| `POLL_INTERVAL_MS` | `3000` | Initial job polling interval in milliseconds. |
| `POLL_MAX_INTERVAL_MS` | `15000` | Maximum backoff polling interval in milliseconds. |
| `MAX_SOURCE_MB` | `15` | Maximum upload size for source mockups (in MB). |
| `MAX_SOURCE_PIXELS` | `50000000` | Maximum pixel edge bound (width × height). |
| `MAX_VIDEO_MB` | `500` | Maximum video size (in MB). |
| `LOG_RETENTION_DAYS` | `30` | Number of days before log files are cleaned up. |
| `POD_ADMIN_USERS` | `PLACEHOLDER` | Comma-separated Windows usernames with Admin role. |
| `CSC_LINK` | `PLACEHOLDER` | Path or base64 certificate for Windows code signing. |
| `CSC_KEY_PASSWORD` | `PLACEHOLDER` | Password for the code-signing certificate. |

---

## Development Commands

### Which command when

| Task | Command | Time |
|---|---|---|
| Day-to-day UI / logic changes | `npm run dev` (keep it running; renderer reloads instantly, main restarts on save) | seconds |
| Tests | `npm test` / `npm run test:watch` | seconds |
| Try it exactly like the installed app, without installing | `npm run dist:dir` → run `releasewin-unpackedPOD Video Studio.exe` | ~1–2 min |
| Change a Muse4AI patch | `npm run build:muse4ai` (`build:muse4ai:fast` skips its tests) | minutes, rare |
| Release for employees | `npm run dist` | slowest, only for a new version |

Muse4AI is built **once** into `vendor/muse4ai/dist`; `npm run dev` then manages it like the installed app.
Dev `.env`: `PROVIDER_MODE=bridge`, `MUSE_PLATFORM_ORIGIN=https://muse.ai`, `MUSE_BRIDGE_BASE_URL=http://127.0.0.1:47821`
(`MUSE_BRIDGE_API_KEY` optional — POD asks the bundled Muse4AI for one). Use `PROVIDER_MODE=mock` for offline UI work
(no Muse calls, no quota used).

All dependencies are pinned and pre-installed in the repository.

```powershell
# Run the application in development mode
npm run dev

# Run TypeScript typechecks (node and web targets)
npm run typecheck

# Run ESLint across the codebase
npm run lint

# Run Vitest unit and integration test suite
npm test

# Run tests in watch mode
npm run test:watch
```

---

## Building the Installer

Build the production application and generate the Windows NSIS installer:

```powershell
# Compile the main, preload, and renderer packages
npm run build

# Package and build the Windows installer (.exe) into release/
npm run dist
```

The resulting per-user installer is written to `release/POD Video Studio Setup <version>.exe`.
