# CAL-4 — Calendar UI: dual upload, template auto-select, Admin, Library

Read `docs/tasks/COMMON.md`, then `docs/tasks/CAL-COMMON.md`, then brief `calendar-category-integration.md`
§2, §3.1 (Admin), §3.2 (UI mapping), §4.2, §10, §13 "UI / IPC". Also `docs/tasks/W4-ui.md` for UI conventions.

## You own
- `src/renderer/**`

## Build
1. **CreateVideo** (`src/renderer/src/screens/CreateVideo.tsx`, split into components if it grows):
   - Apparel/other categories: exactly today's single dropzone and behaviour (no visual change).
   - `selectedCategory.promptGroup === 'calendar'`: two labelled dropzones **Front Cover** (existing staged image =
     `sourceToken`) and **Interior Artwork** (`interiorArtworkStaged`), each one-file-only, each calls
     `api.images.stageFile(file)` (or `pick()`) independently, separate preview, Remove and Replace per image.
   - Generate enabled only when both images staged + existing SKU/category/template/prompt/provider checks.
   - Payload: `interiorArtworkToken` included **only** when calendar and staged; never for other categories, even if
     stale state exists (state may be kept for switching back, but never sent).
   - Soft warning (non-blocking) when artwork aspect ratio differs from front cover aspect ratio by > 15% (use the
     staged image width/height already returned to the renderer; do not read image bytes in the renderer).
   - Keep one-click/single-flight/idempotency (`clientRequestId`) behaviour exactly.
2. **Template auto-select**: on category change, if group is `calendar` select template id `calendar-review`
   (its default/latest version from `prompts.listTemplates()`; if missing, show a clear message and keep Generate
   disabled); when switching from calendar to another group restore the previous non-calendar default
   (`product-review` / configured default). A manual template choice is not overridden until the category changes.
3. **Admin Categories** (`src/renderer/src/screens/Admin.tsx`): add `<option value="calendar">Calendar</option>`.
4. **Library / Queue**: when `JobView.interiorArtworkUrl` is a non-empty string, show Front Cover + Interior Artwork
   thumbnails next to the video in Library details; a small "Calendar" badge in Queue. Fields may be absent until the
   orchestrator task lands — handle `undefined`.
5. **i18n** (`src/renderer/src/i18n/en.ts`): Front Cover, Interior Artwork, Remove/Replace artwork, "Interior artwork
   is required for Desk Calendar", aspect-ratio warning, calendar badge, `CALENDAR_COMPOSITING_FAILED` display if the
   renderer maps error codes. No hard-coded strings in components.

## Required tests (follow the existing renderer test setup; if none for components, add pure-function tests for
extracted logic e.g. `buildCreateJobPayload`, `isGenerateEnabled`, `pickTemplateForCategory`, `aspectWarning`)
- Apparel: one dropzone, Generate possible with one image, payload has no `interiorArtworkToken`.
- Calendar: two dropzones; Generate disabled until both staged; payload has both tokens.
- Switching calendar → T-shirt with artwork staged: payload omits `interiorArtworkToken`.
- Selecting calendar picks `calendar-review`; selecting T-shirt keeps/restores `product-review`; manual choice not
  overridden without category change.
- Aspect warning threshold.
- Double click still creates exactly one request (existing test stays green).
- `npm run build` succeeds.

## Definition of done
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass; only owned paths changed vs `dev`;
`worker_done` report with a short description (or screenshot path) of both layouts.
