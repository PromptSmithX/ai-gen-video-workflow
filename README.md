# POD Video Studio

POD Video Studio is an internal desktop application for generating high-fidelity product review videos from product mockup images using the company-approved Muse video generator.

The application allows employees to drag and drop product mockups, select SKUs and categories, preview and edit company-standard prompt templates, and receive validated MP4 videos organized automatically into the SKU media library.

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
  `%APPDATA%\pod-video-studio\.env` (or `<userData>/.env`).
  This allows testing and custom configurations on installed desktop builds.
- **Explicit Override:** Pass `envFilePath` to `loadConfig` to load an explicit file path.

### Bridge API Key Storage: Recommended vs Fallback
- **Recommended (Production):** Enter the bridge API key in the **Admin** settings screen. It is encrypted using Windows DPAPI via Electron's `safeStorage` and stored with restrictive permissions (`0o600`).
- **Testing Convenience:** `MUSE_BRIDGE_API_KEY` may be set in `.env` as a fallback when no DPAPI secret has been saved. It is read on-demand in both development and installed mode, is never persisted to the secret store, and is never written to logs or diagnostics.

Copy `.env.example` to `.env` for local development. **Never commit `.env`.**

All URLs and keys are company-supplied and must use placeholders:

| Variable | Default / Format | Description |
|---|---|---|
| `PROVIDER_MODE` | `mock` | `mock` (offline, no network) or `bridge` (approved local Muse bridge) |
| `MUSE_PLATFORM_ORIGIN` | `PLACEHOLDER` | Exact HTTPS origin of Muse product (e.g. `https://muse.ai`) |
| `MUSE_BRIDGE_BASE_URL` | `PLACEHOLDER` | Loopback-only bridge base URL (e.g. `http://127.0.0.1:47821`). Trailing slashes are automatically stripped. |
| `MUSE_BRIDGE_API_KEY` | `PLACEHOLDER` | Convenience API key fallback. Admin screen (DPAPI) is recommended for production. |
| `PROMPT_MASTER_PATH` | `PLACEHOLDER` | Optional absolute path to company Prompt Master markdown file. |
| `POD_LIBRARY_ROOT` | `<Documents>/POD_VIDEO_LIBRARY` | Destination folder for SKU video library. |
| `PROMPT_MAX_CHARS` | `4000` | Maximum character length for prompts. |
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
