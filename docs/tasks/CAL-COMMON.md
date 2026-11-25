# Calendar feature — rules for every CAL worker (read first, after `docs/tasks/COMMON.md`)

Feature brief: `calendar-category-integration.md` at the repo root (Vietnamese + English). Read §0 and the
sections your task cites. **All `COMMON.md` hard rules still apply**, with these overrides:

- **Base branch is `dev`**, not `main`. The lead merges your branch into `dev`. Do not merge/rebase/push yourself.
  Check your scope with `git diff --stat dev...HEAD`.
- The shared contracts for this feature are **already locked on `dev`** — implement against them, do not edit them:
  - `src/shared/domain.ts`: `Category.promptGroup` includes `'calendar'`; `DEFAULT_CATEGORIES` includes
    `{ id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' }`; `AssetRole` includes `'interior_artwork'`.
  - `src/shared/ipc.ts`: `CategorySchema` accepts `calendar`; `CreateJobInput.interiorArtworkToken?: string`;
    `JobView.interiorArtworkUrl?: string | null`.
  - `src/shared/errors.ts`: new code `CALENDAR_COMPOSITING_FAILED` with a safe message.
  - `src/shared/services.ts`: `MediaLibrary.importInteriorArtwork(absPath, sku)`; `CalendarArtworkCompositor`,
    `CalendarCompositionInput`, `CalendarCompositionReport`.
- Non-negotiable product rules (brief §0): the apparel/T-shirt flow, its prompts, provider payload and output stay
  unchanged; **only the front cover ever reaches the provider** (Muse4AI/Muse contract untouched: one
  `sourceImagePath`, one `reference_id`); interior artwork is local-only, byte-identical, SHA-256 tracked; no
  generative AI touches the artwork; low tracking confidence ⇒ fail safely, never a "successful" misaligned video.
- Existing tests must stay green and unchanged unless your task explicitly says otherwise. Add new tests for
  everything listed under "Required tests".
- If you need a shared-contract change, a new dependency, or an edit outside "You own", run
  `orca orchestration ask ...` and wait.
- Finish with `worker_done`: summary, files changed, test counts (typecheck/lint/test output tail), open issues.
