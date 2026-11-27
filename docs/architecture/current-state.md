# Current state and proposed architecture

_Last updated: 2026-11-23 — MVP integrated (W1–W6 merged, 193 tests, NSIS installer builds). Remaining gates below._

## Repository at start
The repository contained only `POD_VIDEO_STUDIO_AGENT_BRIEF.md` — no existing framework, build pipeline, tests,
data layer or security controls to reuse. Per brief §3.2 the stack chosen for an empty repo is
**Electron + TypeScript + React**.

## Stack
| Concern | Choice | Notes |
|---|---|---|
| Shell | Electron 45 (Node 24.22 runtime) | `sandbox`, `contextIsolation`, no `nodeIntegration` |
| Build | electron-vite 6 / Vite 8 | `out/main`, `out/preload`, `out/renderer` |
| UI | React 19, plain CSS | renderer only talks to `window.api` |
| Validation | zod 4 | every IPC payload validated in main |
| Database | built-in `node:sqlite` (`DatabaseSync`) | no native module to rebuild for Electron; WAL; local disk only |
| Tests | vitest 5 (node + jsdom) | provider always mocked; no live Muse calls in CI |
| Installer | electron-builder NSIS, per-user | signing via `CSC_LINK` (empty = unsigned dev build) |

`better-sqlite3` was evaluated and dropped: it has no prebuilt binary for Electron 45 on this machine and would
need a native toolchain on every build host. `node:sqlite` is available in both Node 24 (tests) and Electron 45.

## Module layout (maps to brief §3.2)
| Brief module | Path |
|---|---|
| PODStudio.Domain | `src/shared/*` (contracts, pure) + `src/main/domain` |
| PODStudio.App | `src/main/app` (job orchestrator, use cases), `src/main/ipc` |
| PODStudio.Infrastructure | `src/main/infra/{db,media,config,secrets,logging,diagnostics}` |
| PODStudio.Providers.Muse | `src/main/providers/muse` (only module that knows the bridge contract) |
| PODStudio.UI | `src/renderer`, `src/preload` |
| PODStudio.Installer | `electron-builder.yml`, `build/`, `.github/workflows` |
| Prompt Master | `prompts/` (built-in, placeholder) + `src/main/prompts` |

## Data flow
Renderer → `window.api` (preload, contextBridge) → `ipcMain.handle` (zod-validated) → `JobOrchestrator`
→ `PromptService` / `MediaLibrary` / `PodDatabase` / `MuseProvider` → approved local Muse bridge
(`127.0.0.1` only) → MP4 downloaded to `.part`, validated, hashed, atomically moved under
`POD_VIDEO_LIBRARY/<SKU>/videos/`.

## Configuration
Everything the company must supply (Muse origin, bridge URL, API key, Prompt Master path, library root,
signing cert) is a blank key in `.env` (see `.env.example`). In the installed app, admin settings are stored in the
SQLite `settings` table and the bridge API key in DPAPI-encrypted storage (`safeStorage`), never in `.env`.

## Gates still open (owner: company)
- Exact Muse origin and terms/automation approval — `docs/integration/platform-compatibility.md`.
- Company-approved Prompt Master V2 text — currently a marked placeholder.
- Code-signing certificate.
- Calendar prompt `calendar-review` v1 is a marked placeholder — approve via Admin/Prompt Master.
- Calendar compositor validated on synthetic fixtures only; must be validated on real Muse calendar videos
  before production (brief §14). Bundled `ffmpeg.exe` must be an **LGPL** build for commercial release
  (the dev machine's build is GPL v3) — see `docs/sbom/calendar-compositor.md`.

## Desk Calendar (2026-11-25, `calendar-category-integration.md`)
- Category `desk-calendar` (`promptGroup: 'calendar'`): two uploads — front cover (only image sent to Muse) and
  interior artwork (local-only, byte-identical `interior_artwork` asset, SHA-256, DB migration v2).
- After download, `JobOrchestrator.handleDownloading` runs the bundled sidecar compositor
  (`src/main/infra/compositor`, `tools/calendar-compositor`, ADR-004) before `storeVideo`; failure ⇒
  `DOWNLOAD_FAILED` + `CALENDAR_COMPOSITING_FAILED`, `retry_download` re-processes without a new submit.
- Build the sidecar with `npm run build:compositor` (Python + PyInstaller venv in `tools/calendar-compositor/.venv`)
  before `dist`; without it calendar jobs fail safely, apparel is unaffected.
