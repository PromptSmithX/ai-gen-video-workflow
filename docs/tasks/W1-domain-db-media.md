# W1 — Domain, SQLite database and SKU media library

Read `docs/tasks/COMMON.md` first, then brief §5 (SKU rules), §7 (storage + metadata), §8 (state machine),
§9 "File handling", §10 unit tests.

## You own
- `src/main/domain/**`
- `src/main/infra/db/**`
- `src/main/infra/media/**`

## Build
### 1. Domain (`src/main/domain/`)
- `job-machine.ts`: pure helpers on top of `@shared/job-state` — `assertTransition(from,to)` throwing
  `PodError('INVALID_STATE')`, `isTerminal`, `isActive`, `nextActionsFor(job, capabilities)` returning
  `JobNextAction[]` from `@shared/ipc` with these rules:
  FAILED_RETRYABLE → `retry`; FAILED_PROVIDER → `retry` only if `job.attempt < 2`, plus `regenerate`;
  AMBIGUOUS → `check_ambiguous`; DOWNLOAD_FAILED → `retry_download`; SUCCEEDED/FAILED_REFUSED/FAILED_QUOTA/
  CANCELLED → `regenerate`; QUEUED/RUNNING → `cancel` only if `capabilities?.canCancel`; else `none`.
- `ids.ts`: `newId()` using `crypto.randomUUID()`; `nowIso()`.

### 2. Database (`src/main/infra/db/`)
- `index.ts` exports `openDatabase(filePath: string): PodDatabase` (contract in `@shared/services`).
  Use `node:sqlite` `DatabaseSync`. Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
  `':memory:'` must work for tests.
- `migrations.ts`: ordered, versioned migrations tracked in a `schema_migrations` table; each applied in a
  transaction; idempotent on re-open. Migration 1 creates:
  - `products` (id TEXT PK, sku TEXT UNIQUE NOT NULL, category, product_name NULL, created_at, updated_at)
  - `jobs` — every field of `Job` in `@shared/domain` as snake_case columns, `idempotency_key TEXT UNIQUE NOT NULL`,
    `provider TEXT NOT NULL CHECK(provider='muse')`, `state` CHECK in JOB_STATES, FK product_id → products.
    Indexes on state, sku_snapshot, created_at.
  - `assets` (§7 fields + role CHECK, FK product_id, job_id NULL) — `path` is relative only.
  - `settings` (key TEXT PK, value_json TEXT NOT NULL, updated_at).
- Repositories implementing `ProductRepository`, `JobRepository`, `AssetRepository`, `SettingsRepository`.
  Parameterized statements only, rows mapped to camelCase DTOs (booleans as 0/1 in SQL).
  `jobs.transition()` must be atomic: `UPDATE ... WHERE id=? AND state=?` (expected current state) and verify
  `changes === 1`, validating with `canTransition`; else throw `PodError('INVALID_STATE')`.
  `jobs.insert()` with a duplicate idempotency key throws `PodError('INVALID_STATE')`.
  `list(filter)` supports every `JobFilter` field, newest first, default limit 200.
- `backup(destPath)` via `node:sqlite` `backup()`; add a `restoreFrom(backupPath, targetPath)` helper (copy
  when closed) and test backup→restore round trip.
- Suppress nothing globally; if the `ExperimentalWarning` for sqlite is noisy, leave it (W6 handles process flags).

### 3. Media library (`src/main/infra/media/`)
- `index.ts` exports `createMediaLibrary(opts)` returning `MediaLibrary` (signature in `@shared/services`).
- `sku-path.ts`: uses `normalizeSku` from `@shared/domain`; builds `<root>/<SKU>/{source,prompts,videos,metadata}`
  with `path.join` and then verifies `path.relative(root, p)` does not start with `..` and is not absolute.
  `resolve(relPath)` rejects absolute input, `..` segments, drive letters, UNC, NUL bytes, and checks with
  `fs.realpathSync` that the real path is still inside the real root (symlink / junction escape).
- `image.ts`: read the header bytes (do not trust extension): PNG (`89 50 4E 47 0D 0A 1A 0A` + IHDR w/h),
  JPEG (`FF D8 FF`, parse SOF0/SOF1/SOF2 markers for w/h), WEBP (`RIFF....WEBP`, VP8 / VP8L / VP8X dims).
  Enforce `maxSourceBytes` and `maxSourcePixels` (decompression-bomb guard) **before** reading the whole file.
  Errors: `INVALID_IMAGE`, `IMAGE_TOO_LARGE`. No image decoding library — header parsing only.
- `video.ts`: MP4/ISO-BMFF check — first box type must be `ftyp` with a sane size, and an `moov` or `mdat` box must
  exist when walking top-level boxes; enforce `maxVideoBytes`; reject empty/truncated files.
- `hash.ts`: streaming SHA-256.
- `importSourceImage`: validate, then **byte-identical** copy to `<SKU>/source/<SKU>-original.<ext>`
  (`-original-2`, `-3`… if exists); return `StoredFile`. Never re-encode.
- `storeVideo`: validate + hash the `.part` file, pick next `<SKU>-video-NNN.mp4` (3-digit, increments),
  write via rename (same volume: temp dir lives under library root `.tmp/` OR copy+fsync+rename when cross-volume),
  delete the temp on failure, throw `PodError('DOWNLOAD_FAILED')` on invalid.
- `newTempPath()` → unique `<tempDir>/<uuid>.part`; create `tempDir` with `fs.mkdirSync(..., { recursive: true })`.
- `writeMetadata` writes pretty JSON; `writePromptSnapshot` writes UTF-8 markdown. Files never auto-opened.
- Add `cleanupTemp(olderThanMs)` helper returning number of removed `.part` files.

## Required tests
- SKU: valid/invalid cases, traversal (`../x`, `..\\x`, `C:\\x`, `\\\\server\\share`, NUL), reserved names.
- `resolve()` rejects traversal and a symlink/junction pointing outside the root (skip the symlink case gracefully
  if the OS denies symlink creation, but keep the junction case on Windows: `fs.symlinkSync(target, link, 'junction')`).
- Image: real minimal PNG/JPEG/WEBP fixtures built in-test from bytes → correct mime/dims; wrong signature with
  `.png` extension rejected; oversize bytes and oversize pixels rejected without reading full file.
- Video: valid minimal `ftyp`+`moov` fixture accepted; text file renamed `.mp4`, truncated box, empty file rejected.
- SHA-256 matches `crypto` digest of fixture.
- importSourceImage is byte-identical (hash equal); second import gets `-original-2`.
- storeVideo numbering 001 → 002; temp removed on failure.
- Migrations: fresh db, re-open idempotent, `schema_migrations` version recorded.
- Repos: upsertBySku, unique SKU, insert job, duplicate idempotency key rejected, transition allowed/forbidden,
  concurrent-change detection (state changed between read and transition), list filters, settings round trip.
- Backup → restore round trip keeps rows.
- `nextActionsFor` table test.
