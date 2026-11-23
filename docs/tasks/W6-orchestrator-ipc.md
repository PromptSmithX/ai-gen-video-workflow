# W6 — Job orchestrator, IPC wiring, preload and end-to-end tests (wave 2)

Read `docs/tasks/COMMON.md` first, then brief §3.1, §4.4–4.5, §5, §8 (entire), §9, §10 integration tests.
This task starts after W1 (db/media), W2 (prompts), W3 (provider) and W5 (config/secrets/logging) are merged
into `main`. Use their exported factories — do not reimplement them. If one of them needs a change, ask the
coordinator instead of editing it.

## You own
- `src/main/app/**` (orchestrator + use cases)
- `src/main/ipc/**`
- `src/main/index.ts` (replace the Phase 0 skeleton)
- `src/preload/**`
- `test/e2e/**` (integration tests of the whole main-process stack against the mock bridge)

## Build
### 1. Composition root (`src/main/index.ts` + `src/main/app/container.ts`)
- On `app.whenReady`: single-instance lock; paths (`app.getPath('userData'|'documents')`); `loadConfig`;
  `createLogger`; `createSecretStore({ safeStorage, filePath: <userData>/secrets.json })`;
  `openDatabase(<userData>/pod-studio.db)`; `createMediaLibrary` (tempDir `<libraryRoot>/.tmp` so renames are
  same-volume); `createPromptService({ builtinDir: <resources>/prompts in prod or <repo>/prompts in dev, adminDir:
  <userData>/prompts, companyMasterPath })`; `createMuseProvider`; `JobOrchestrator`; IPC handlers; window.
- Employee identity: `os.userInfo().username`; admin via the W5 `isAdmin` helper.
- Register the `pod-media` protocol (`protocol.handle`) serving **only** `asset/<uuid>` (looked up in the assets
  table → `media.resolve(relPath)`) and `staged/<token>`; correct content types; everything else 404. Register it as
  privileged with `stream: true` so `<video>` can seek.
- BrowserWindow security exactly as in the skeleton (sandbox, contextIsolation, no nodeIntegration, deny window
  open/navigation). No network listener is opened by the app.

### 2. Orchestrator (`src/main/app/job-orchestrator.ts`)
One authoritative coordinator (brief §8):
- `createJob(input, employeeId)`: validate SKU (`normalizeSku`), staged image token, category, template; render
  prompt (or validate override) — reject when `errors.length>0` or quality fails; if `clientRequestId` already
  exists as an idempotency key → return the existing job (no new job). In one db transaction: upsert product,
  import source image (asset `source_image`), write prompt snapshot (asset `prompt_snapshot`; prompt text is stored
  only there, the job keeps `prompt_sha256`), insert job `QUEUED` with `idempotencyKey = clientRequestId`.
- Single-flight worker loop: at most **one** concurrent provider generation (configurable constant 1). Picks the
  oldest QUEUED job.
- Submit: **persist `SUBMITTING` + `submitIntentAt` before calling `provider.generateVideo`.** Result mapping:
  confirmed → `RUNNING` (+providerJobId, referenceId, acceptedAt); `ambiguous` → `AMBIGUOUS` (`SUBMIT_AMBIGUOUS`);
  `ProviderError` with phase `before_submit` → `FAILED_RETRYABLE` (or `FAILED_QUOTA`/`FAILED_REFUSED` by code);
  `after_submit`/`unknown` → `AMBIGUOUS` unless the code is a definite refusal/quota → those states.
- Poll RUNNING jobs with W3's `nextPollDelay` (base/max from config). Never create a job while polling.
  succeeded → `DOWNLOADING` → `provider.downloadOutput(tempPath)` → `media.storeVideo` → asset `generated_video`
  + metadata json (sanitized: ids, sku, template id/version, prompt sha, hashes, timestamps — no prompt text, no
  paths) → `SUCCEEDED`. Errors → `DOWNLOAD_FAILED` / `OUTPUT_MISSING` code. failed → mapped FAILED_* state.
- Manual actions: `retry` (FAILED_RETRYABLE, or FAILED_PROVIDER with attempt<2; requires acknowledged; same job,
  same idempotency key, attempt+1); `regenerate` (requires confirmed; new job + new key from new clientRequestId,
  `regeneratedFromJobId` set, reuses source asset); `resolveAmbiguous('check_again')` → `findJobByRequestId` if
  supported → RUNNING when found, stays AMBIGUOUS when unknown; `mark_failed` → `FAILED_PROVIDER`;
  `retryDownload` (DOWNLOAD_FAILED → DOWNLOADING, no new generation); `cancel` only if capability.
- Restart recovery (`recover()` on startup): QUEUED → stays queued; **SUBMITTING → AMBIGUOUS** (we cannot know if it
  was sent); RUNNING → resume polling; DOWNLOADING → retry download. Never resubmit.
- Emits `JobView` updates (EventEmitter) consumed by IPC → `webContents.send(IPC.jobsUpdated, view)`.
- Logs only ids, sku, states, codes, durations.

### 3. IPC (`src/main/ipc/`)
- One `handle(channel, schema, fn)` helper: `ipcMain.handle`, validates the sender frame URL is the app's own
  renderer, parses input with the zod schema from `@shared/ipc`, wraps results in `IpcResult`, converts
  `PodError` to `SafeError`, unknown errors to `INTERNAL` (logged redacted).
- Implement every `PodApi` method. Admin-only channels check `isAdmin` → `FORBIDDEN`.
- `images.pick`: `dialog.showOpenDialog` filtered to png/jpg/jpeg/webp → `media.validateImage` → stage with a random
  token (map token → abs path in memory, expires after 1 h). `images.stagePath` the same for drag&drop paths.
- `library.openFolder` → `shell.showItemInFolder(videoAbsPath)` (never `openPath` on media);
  `library.copyPath` → `clipboard.writeText`.
- `admin.updateSettings` persists to the settings table, reloads config, recreates the provider.
- Diagnostics via W5's `buildDiagnostics`; export through `dialog.showSaveDialog`.

### 4. Preload (`src/preload/index.ts`)
`contextBridge.exposeInMainWorld('api', api satisfies PodApi)`; `images.stageFile(file)` uses
`webUtils.getPathForFile(file)` then invokes `images:stagePath`. `jobs.onUpdated` registers an `ipcRenderer.on`
listener and returns an unsubscribe. Expose nothing else (no raw ipcRenderer).

## Required tests (`test/e2e/*.test.ts`, Electron-free: construct the orchestrator with real db (`:memory:` or temp
file), real media library in a temp dir, real prompt service on `prompts/`, and the W3 mock provider or
RestBridge provider against W3's `test/mock-bridge`)
- Happy path: create → QUEUED → SUBMITTING → RUNNING → DOWNLOADING → SUCCEEDED; MP4 stored at
  `<SKU>/videos/<SKU>-video-001.mp4`, assets + metadata rows exist, sha matches.
- Same clientRequestId twice → one job, bridge saw one `POST /v1/jobs`.
- Network interruption after submit (bridge hangs after body) → AMBIGUOUS, and after `recover()`/more ticks still
  exactly one POST.
- Crash simulation: job left in SUBMITTING in db → `recover()` → AMBIGUOUS, no submit.
- RUNNING job survives restart (new orchestrator instance on same db file) and completes.
- Refused / quota / 5xx / no asset / corrupt mp4 → expected states + codes; quota does not loop.
- Retry of FAILED_RETRYABLE reuses the idempotency key; PROVIDER_ERROR retry allowed once only.
- Regenerate requires confirmation and creates a new key.
- Prompt with unknown placeholder / too long → createJob rejected, no job row.
- IPC helper: invalid payload → `ok:false` with code, no throw; non-admin calling admin channel → FORBIDDEN.
- Logs written during the e2e run contain no prompt text and no API key.

## Integration notes from the lead (actual merged APIs — use these)
- Config: `readEffectiveEnv({ env: process.env, isDev, userDataDir, cwd })` + `loadConfig({ env, settings, paths:{userData, documents}, isDev })`
  from `src/main/infra/config`; `isAdmin(config, username)`. Admin settings come from `db.settings` (key `admin_settings`).
- Secrets: `createSecretStore({ safeStorage, filePath })` and `getBridgeApiKey(store, effectiveEnv)` from `src/main/infra/secrets`
  (pass the env returned by `readEffectiveEnv`, not raw `process.env`, so a key in `.env` works).
- Logging: `createLogger({ dir: <userData>/logs, retentionDays })`, `cleanupLogs(dir, days)`, `redactText`.
- Diagnostics: `buildDiagnostics(...)`, `exportDiagnosticsToFile(path, content)` from `src/main/infra/diagnostics`.
- DB: `openDatabase(path)`. **`db.transaction(fn)` is synchronous** — never `await` inside it. In `createJob` do the async file work
  first (`media.importSourceImage`, `media.writePromptSnapshot`), then a single sync transaction for product upsert + asset rows +
  job insert. If the transaction fails, best-effort delete the files you just wrote.
- Media: `createMediaLibrary({ root, tempDir, maxSourceBytes, maxSourcePixels, maxVideoBytes })`; temp cleanup via exported
  `cleanupTemp(tempDir, olderThanMs)`. Domain helpers: `newId`, `nowIso`, `assertTransition`, `nextActionsFor` in `src/main/domain`.
- Prompts: `createPromptService({ builtinDir, adminDir, companyMasterPath })` from `src/main/prompts`. builtinDir = `join(app.getAppPath(),'prompts')`
  in dev, `join(process.resourcesPath,'prompts')` when packaged (electron-builder copies `prompts/` there as extraResources).
- Provider: `createMuseProvider({ config, getApiKey, logger })`, `nextPollDelay`, `createMinimalValidMp4` from `src/main/providers/muse`.
  Mock scenario can be chosen in dev with env `POD_MOCK_SCENARIO`. Mock bridge server for tests: `test/mock-bridge/server.ts`.
- `src/renderer/**` is owned by W4 (still in review) — do not edit it. Your preload must satisfy `PodApi` exactly.
- In dev, `npm run dev` must start with `PROVIDER_MODE=mock` and an empty `.env` without crashing.
