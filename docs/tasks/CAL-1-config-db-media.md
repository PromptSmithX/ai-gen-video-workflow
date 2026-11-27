# CAL-1 — Calendar: config category merge, DB migration v2, interior artwork import

Read `docs/tasks/COMMON.md`, then `docs/tasks/CAL-COMMON.md`, then brief `calendar-category-integration.md`
§3.1, §4.3, §5 (entire), §13 "Domain / config / prompts" + "Media / DB".

## You own
- `src/main/infra/config/**`
- `src/main/infra/db/**`
- `src/main/infra/media/**`

## Build
### 1. Config category merge (`src/main/infra/config/index.ts`)
Today stored `settings.categories` fully replace `DEFAULT_CATEGORIES`, so existing installs would never see
Desk Calendar. Change normalization so that:
- No stored categories → `DEFAULT_CATEGORIES` (already includes `desk-calendar`).
- Stored categories present → keep them exactly (order, labels, groups, custom ids) and **append
  `desk-calendar` only if no stored category has id `desk-calendar`**. Never overwrite/rename admin categories.
- Do not re-append if an admin deliberately deleted it? → We cannot distinguish that from a legacy install without a
  marker. Implement: append only when the stored list has **no category with `promptGroup === 'calendar'`** and no
  id `desk-calendar`. Document this in a code comment.
- Zod schema already accepts `calendar` (lead changed it); keep it.

### 2. Migration v2 (`src/main/infra/db/migrations.ts`)
Add `{ version: 2, name: 'assets_interior_artwork_role', up }` that rebuilds `assets` so the `role` CHECK also allows
`'interior_artwork'` (brief §5.2): create `assets_new` with the **identical** column list/types/defaults/FKs as the v1
table (copy them from migration 1), copy all rows with an explicit column list, drop `assets`, rename, recreate
`idx_assets_product_id` and `idx_assets_job_id`. Must run inside the existing per-migration SAVEPOINT in
`runMigrations()`. If foreign-key enforcement is on, make sure rebuild cannot cascade-delete or fail (check
`PRAGMA foreign_keys` behaviour inside a savepoint — `PRAGMA foreign_keys` cannot change inside a transaction, so rely
on the fact that `DROP TABLE assets` has no dependents referencing assets; verify with a test).
Asset repository: make sure `interior_artwork` round-trips (types already allow it).

### 3. `importInteriorArtwork(absPath, sku)` (`src/main/infra/media/index.ts`)
Replace the lead's stub. Same SKU normalization, `validateImage()` (signature, `maxSourceBytes`, `maxSourcePixels`,
extension not trusted), path safety and collision handling as `importSourceImage()`, but files go to
`<SKU>/source/<SKU>-interior-artwork.<ext>`, then `-interior-artwork-2.<ext>`, … Byte-identical copy (no
re-encode), SHA-256, width/height in the returned `StoredFile`. Reuse existing helpers — refactor
`importSourceImage` into a shared private helper parameterized by the basename suffix rather than duplicating code
(its behaviour and file names must not change).

## Required tests
- Config: fresh config has `desk-calendar`; legacy stored list without it gets it appended at the end, custom
  categories untouched (label/order); stored list already containing `desk-calendar` (even with edited label) is
  untouched; stored list with another `calendar`-group category does not get a second one; invalid `promptGroup`
  still rejected; `calendar` accepted.
- Migration: build a **v1-only** database (run only migration 1 + insert products/jobs/assets rows of all 4 old roles),
  then run `runMigrations()` → schema version 2, every old asset row identical (all columns), indexes exist,
  inserting `interior_artwork` works, an unknown role still fails the CHECK, re-opening is idempotent.
- Media: `importInteriorArtwork` byte-identical + correct SHA-256 + dimensions; `-interior-artwork-2` on second
  import; rejects bad signature (e.g. PNG extension with text bytes), oversize bytes, oversize pixels, invalid SKU;
  path traversal impossible; `importSourceImage` tests unchanged and green.

## Definition of done
`npm run typecheck`, `npm run lint`, `npm test` pass; only owned paths changed vs `dev`; `worker_done` report.
