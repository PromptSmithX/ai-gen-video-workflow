# CAL-3 — Local Calendar Artwork Compositor (sidecar spike + implementation)

Read `docs/tasks/COMMON.md`, then `docs/tasks/CAL-COMMON.md`, then brief `calendar-category-integration.md`
§7 (entire), §11, §12 W-CAL-4, §13 "Post-processing", §14.

**Decision already made by the user:** implementation is a **bundled sidecar executable** (Python + OpenCV +
NumPy frozen with PyInstaller) plus a bundled `ffmpeg.exe`/`ffprobe.exe`, spawned from main with
`spawn(exe, args, { shell: false })`. No Node native addon, no npm dependency, no network, no generative model.
No real Muse calendar videos exist yet → you build **synthetic fixture videos**.

Machine facts: Python 3.13 (miniconda) with `cv2` 5.0 and `numpy` 2.4 is on PATH; `ffmpeg`/`ffprobe` at
`C:\ffmpeg\bin`. PyInstaller is NOT installed globally — create a venv in `tools/calendar-compositor/.venv`
(gitignore it) and install pinned versions from `tools/calendar-compositor/requirements.txt` there. Do not touch
the global Python.

## You own
- `tools/calendar-compositor/**` (Python source, `requirements.txt` with exact pins, `build.ps1`, fixture generator,
  Python tests, README)
- `src/main/infra/compositor/**` (TypeScript adapter + tests)
- `docs/architecture/adr-004-calendar-compositor.md`
- `docs/sbom/calendar-compositor.md` (sources, versions, licenses of OpenCV, NumPy, PyInstaller, FFmpeg build)
- `.gitignore` — only to add the venv, build and generated-fixture output folders

Do **not** edit `electron-builder.yml`, `package.json`, `src/main/app/**` or shared files. In the ADR, state the exact
`extraResources` entry the lead must add (proposal: `vendor/calendar-compositor/dist` → `calendar-compositor`, holding
`calendar-compositor.exe`, `ffmpeg.exe`, `ffprobe.exe`), and the build output location (`vendor/calendar-compositor/dist`,
gitignored).

## Build
### 1. Sidecar CLI (`tools/calendar-compositor/`)
`calendar-compositor --input <mp4> --artwork <img> --output <mp4> --ffmpeg <exe> --ffprobe <exe> --report <json>
[--min-coverage 0.6]` (no shell, args only). Pipeline (brief §7.3):
1. Probe with ffprobe (fps, size, duration, audio presence). Decode frames with OpenCV or ffmpeg pipe.
2. Detect the blank light/cream page quadrilateral (edge/contour + brightness/low-texture segmentation; reject quads
   too small, wrong aspect, non-convex).
3. Find 4 corners at first confident frame; track with optical flow (LK) + RANSAC homography; re-detect to correct
   drift; per-frame confidence (inlier ratio, reprojection error, quad area/shape change vs previous).
4. Warp the original artwork (no resize of the source file; warp in memory) into the quad with a small inset so it
   never covers page edges/spiral; feathered mask edge ≤ 2 px. Fully cover the detected print area (hide any fake
   AI text underneath).
5. Optional V1 hand handling: if a skin-color/foreground mask inside the quad is cheap and robust, keep hand pixels on
   top; otherwise skip. Never draw artwork over fingers you detected.
6. Low-confidence frames: do not draw (no drifting/jumping); apply temporal smoothing of corners on confident runs.
7. Encode H.264 MP4 via ffmpeg, **copy the original audio stream** (or re-mux it) — output duration/fps unchanged.
8. Quality gate: if open-page segment < ~1.5 s, coverage < `--min-coverage`, or page area too small → exit code 3,
   write report with `applied:false`, and **do not write the output file** (delete partial).
9. Report JSON: `applied, processedFrames, visibleFrames, trackingCoverage, lowConfidenceFrames, compositorVersion`
   (+ `artworkSha256` computed by the sidecar). No absolute paths, no image bytes in stdout/stderr/report.
Exit codes: 0 ok, 2 bad input, 3 tracking failed, 4 internal. Deterministic output for the same input.

### 2. Synthetic fixtures + Python tests
`tools/calendar-compositor/fixtures/make_fixtures.py` generates (not committed if > 2 MB total; generate at test time):
(a) static front-facing cream page + audio tone; (b) page with gentle perspective motion/handheld shake; (c) page with
fake "AI" text/numbers printed on it; (d) a skin-coloured blob crossing an edge of the page; (e) page visible < 1 s
or heavily occluded (must fail with exit 3). Tests (pytest or unittest in the venv): corner error vs ground truth
< 2% of page diagonal on (a)(b); artwork fully covers fake text in (c); (e) fails safely with no output file;
audio stream present and duration within 1 frame in output; runtime per 10 s 1080p clip reported.

### 3. Build
`tools/calendar-compositor/build.ps1`: create/refresh venv, PyInstaller `--onedir` (faster start) into
`vendor/calendar-compositor/dist/`, copy `ffmpeg.exe`/`ffprobe.exe` from a path passed as parameter
(default `C:\ffmpeg\bin`). Record the ffmpeg build/version/license (GPL vs LGPL!) in the SBOM; flag it to the lead
if it is a GPL build.

### 4. TS adapter (`src/main/infra/compositor/`)
`createCalendarCompositor({ resourcesDir, tempDir, logger, timeoutMs? }): CalendarArtworkCompositor` (contract in
`src/shared/services.ts`). Resolves `<resourcesDir>/calendar-compositor/calendar-compositor.exe`, `ffmpeg.exe`,
`ffprobe.exe` and refuses to run anything whose real path is outside that folder. Validates input/output paths are
inside `tempDir` / given absolute paths (no user strings in args other than validated paths). `spawn` with
`shell:false`, `windowsHide:true`, timeout (default 10 min) → kill tree, track live children and expose
`dispose()` (kill on app quit). Map exit codes → `PodError('CALENDAR_COMPOSITING_FAILED')` (safe message only);
parse and validate the report JSON with zod; delete partial output on any failure. Log only event names, jobId, sku,
exit code, durations, metrics. Also export `createUnavailableCompositor()` that always throws
`CALENDAR_COMPOSITING_FAILED` (used when the sidecar is not bundled).

## Required tests (vitest, `src/main/infra/compositor/*.test.ts`)
Use a **fake sidecar** (a small node script launched via `process.execPath` is fine only in tests — inject the exe path
through an internal test-only option) to cover: success report parsed; exit 3 → CALENDAR_COMPOSITING_FAILED and
output deleted; malformed report → failure; timeout → killed + failure; exe outside resources dir refused; no
absolute paths in log fields. Python tests from §2 must pass via `tools/calendar-compositor` README command —
include their output in `worker_done`. A vitest integration test that runs the real built sidecar on fixture (a) may
be `skipIf(!exists)`.

## Definition of done
`npm run typecheck`, `npm run lint`, `npm test` pass; Python tests pass; `build.ps1` produced a working exe and you
ran it on all fixtures (paste metrics table: coverage, runtime, peak RAM); ADR + SBOM written; only owned paths
changed vs `dev`; `worker_done` report. If page detection cannot be made reliable on the fixtures, say so plainly
in the report instead of loosening the quality gate (brief §16).
