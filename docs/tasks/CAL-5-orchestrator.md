# CAL-5 — Calendar orchestrator integration (createJob, download post-process, regenerate, wiring)

Read `docs/tasks/COMMON.md`, then `docs/tasks/CAL-COMMON.md`, then brief `calendar-category-integration.md`
§4, §5.4, §6, §7.1–7.2, §7.7–7.8, §9 (entire), §11, §13 "Provider boundary" + "Post-processing" + "Regression".
Also `docs/tasks/W6-orchestrator-ipc.md`. This branch starts from `dev` **after** CAL-1 (media import + migration v2)
and CAL-2 (calendar prompts) were merged, so `importInteriorArtwork` and the `interior_artwork` role work.
CAL-3 (real compositor) may land later: depend only on the `CalendarArtworkCompositor` interface.

## You own
- `src/main/app/**` (job-orchestrator, container, image-staging if needed)
- `src/main/ipc/**`
- `src/main/index.ts` (only for compositor dispose on quit)
- `test/e2e/**`, `test/integration/**`

## Build
1. `OrchestratorDeps.compositor: CalendarArtworkCompositor`. `container.ts`: if
   `src/main/infra/compositor` exists with `createCalendarCompositor`, use it with
   `resourcesDir = packaged ? process.resourcesPath : <appPath>/vendor/calendar-compositor/dist/..` (mirror how
   Muse4AI exe is resolved), else / if exe missing → an "unavailable" compositor that throws
   `CALENDAR_COMPOSITING_FAILED`. If CAL-3 is not merged yet, implement the unavailable fallback locally in
   `src/main/app/` and leave a one-line TODO for the lead to switch to the real factory.
2. `createJob()` (brief §9.1): resolve category; calendar → `interiorArtworkToken` required (missing →
   `INVALID_IMAGE` with a safe message "Interior artwork is required for Desk Calendar"), resolve token,
   `validateImage` both before any import, check idempotency **before** writing files (existing order), import front
   cover (`importSourceImage`) + artwork (`importInteriorArtwork`) + prompt snapshot, then in the **existing single
   synchronous** `db.transaction()` insert the `interior_artwork` asset with `jobId = newJob.id`. On failure
   best-effort delete every file this attempt wrote. Non-calendar: ignore any `interiorArtworkToken` completely.
   No `await` inside `db.transaction()`.
3. `handleSubmit()`: unchanged. Only `job.sourceAssetId` (front cover) goes to `provider.generateVideo()`.
4. `handleDownloading()` (brief §9.3): download to temp as today. Non-calendar → existing code path unchanged.
   Calendar → find the job's `interior_artwork` asset (`db.assets.listByJob`), `media.resolve()` it, verify file exists
   and SHA-256 matches (else `DOWNLOAD_FAILED`-state with `NOT_FOUND`/`CALENDAR_COMPOSITING_FAILED` safe message),
   `compositor.process()` into a second `media.newTempPath()`, then `media.storeVideo(processedPath, sku)` (it
   validates MP4). Metadata adds `calendarPostProcess { applied, interiorArtworkSha256, compositorVersion,
   trackingCoverage, processedFrames, visibleFrames, lowConfidenceFrames }`. Any compositor failure →
   `DOWNLOAD_FAILED` state, `errorCode: 'CALENDAR_COMPOSITING_FAILED'`, provider job id kept, so `retry_download`
   re-downloads and re-processes without a new submit. Delete both temp files in `finally`.
5. `regenerate()` (brief §9.4): for calendar jobs verify the original artwork asset file exists and hash matches,
   then insert a new `interior_artwork` row for the new job pointing to the same relPath/sha256 (no byte copy).
   Missing/mismatch → refuse with safe `NOT_FOUND` / `INVALID_IMAGE` and create no job.
6. `JobView.interiorArtworkUrl`: `pod-media://asset/<id>` for the job's artwork asset, `null` otherwise. Make sure the
   pod-media protocol serves `interior_artwork` assets (check its role allow-list).
7. IPC handler for `jobs.create` passes `interiorArtworkToken` through (schema already has it).

## Required tests
- Calendar create: one `source_image` + one job-linked `interior_artwork` asset; files byte-identical; idempotent
  repeat (same `clientRequestId`) creates no duplicate files/rows; missing artwork token → error, no provider call,
  no files left; DB transaction failure → all new files removed.
- Non-calendar with a stale `interiorArtworkToken` → no artwork asset, behaviour identical to today.
- Provider boundary (mock provider / mock bridge): calendar job submits exactly one reference = front cover bytes;
  artwork bytes/hash never appear in any provider call.
- Download: non-calendar never calls compositor; calendar calls it with the persisted artwork path; success stores the
  **processed** video + metadata `calendarPostProcess`; compositor throws → `DOWNLOAD_FAILED` +
  `CALENDAR_COMPOSITING_FAILED`, no `generated_video` asset, temp files removed; `retryDownload` re-runs download +
  compositor and `generateVideo` call count stays 1; artwork hash mismatch → failure, compositor not called.
- Regenerate calendar job → new job has its own `interior_artwork` row with same path/hash; missing artwork → refused.
- `JobView.interiorArtworkUrl` set for calendar, null for apparel; no absolute paths in any JobView.
- Logs: no image bytes, absolute paths or prompt text (extend `logs-security.test.ts`).
- All existing apparel e2e (happy path, retry, ambiguous submit, idempotency, security) unchanged and green.

## Definition of done
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass; only owned paths changed vs `dev`;
`worker_done` report.
