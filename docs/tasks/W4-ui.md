# W4 — Employee UI (Create / Queue / Library / Admin)

Read `docs/tasks/COMMON.md` first, then brief §1 and §5 (entire), §8 last bullet (no fake progress).

## You own
- `src/renderer/**` (including `src/renderer/index.html` — keep the CSP strict; `src/renderer/src/App.tsx` skeleton
  is yours to replace)

## Constraints
- The renderer talks to main **only** through `window.api` (`PodApi` in `@shared/ipc`). No Node, no `fs`, no
  `electron` imports, no `fetch` to the bridge, no secrets in `localStorage`. Every call returns `IpcResult<T>` —
  handle `ok:false` by showing `error.message`.
- Build a **`fakeApi`** (`src/renderer/src/api/fake-api.ts`) implementing the full `PodApi` in-memory (simulated
  job progression via timers, sample categories/templates, staged image via object URL). Use it when
  `window.api` is missing or empty (`Object.keys(window.api ?? {}).length === 0`) so `npm run dev` works before
  W6 wires the real IPC. Show a small "DEMO DATA" badge when the fake is active.
  Access the API through one module `src/renderer/src/api/index.ts` (`getApi()`).
- No new dependencies: plain React 19 + CSS (CSS modules or one `styles.css`). Simple, clean, accessible
  (labels, focus states, keyboard usable), Vietnamese-friendly fonts (system UI font stack). English UI text,
  centralised in `src/renderer/src/i18n/en.ts` so it can be translated later.
- Layout: left sidebar nav (Create video, Queue, Library, Admin — Admin visible only when `AppInfo.isAdmin`),
  top bar with provider connection pill (from `provider.getStatus`, refreshed every 15 s, click → details).

## Screens
### A — Create video (`screens/CreateVideo.tsx`)
- Large drag-and-drop zone (+ "Browse…" button → `images.pick()`); drop → `images.stageFile(file)`. Accept only
  one file; show errors from main. Preview with natural aspect ratio, zoom-to-fit, image info (type, WxH, size).
- SKU input: live validation with `normalizeSku` from `@shared/domain`, show normalized value, error text.
- Product name (optional), Category select (`catalog.listCategories()`), Template select
  (`prompts.listTemplates()`, default first; show version + "PLACEHOLDER" warning badge when `isPlaceholder`).
- Duration / aspect selects **only** if `ProviderStatus.capabilities` lists supported values.
- Prompt preview panel: auto-refresh (debounced 300 ms) via `prompts.preview(...)`; shows template id+version,
  char count `n / max` (red when over), quality checklist (✓/✗ per rule), errors. "Edit prompt" toggles an
  editable textarea (override) validated with `prompts.validate`; "Reset to template" button.
- `Generate video` button: disabled unless image staged, SKU valid, category+template chosen, prompt valid, and
  provider state is `ready` (or mode is mock). On click: generate `crypto.randomUUID()` clientRequestId **once**,
  disable the button immediately (single-flight ref, not only state), call `jobs.create`, then navigate to Queue
  with the new job highlighted. A second click while pending must not call `create` again.
### B — Queue (`screens/Queue.tsx`)
- Live list (`jobs.list({ states: active+recent })` + `jobs.onUpdated` subscription; unsubscribe on unmount).
- Row: source thumbnail (`sourceUrl`), SKU, category, `stateLabel`, created time, elapsed (ticking), employee id,
  progress bar **only if `progress !== null`**, otherwise an indeterminate spinner for active states.
- Safe error message + exactly the actions in `nextActions`:
  `retry` → confirm dialog "I understand this will submit again" → `jobs.retry({acknowledged:true})`;
  `check_ambiguous` → dialog explaining it may already be running in Muse, buttons "Check again"
  (`resolveAmbiguous check_again`) and "I checked Muse — nothing was generated" (`mark_failed`);
  `retry_download` → `jobs.retryDownload`; `regenerate` → confirm dialog → `jobs.regenerate({confirmed:true,
  clientRequestId: new uuid})`; `cancel` → `jobs.cancel`. Disable action buttons while their call is pending.
### C — Library (`screens/Library.tsx`)
- Filters: SKU search, category, employee, date from/to, template version, status (state), review status.
- Card/table of jobs with source image and `<video controls src={videoUrl}>` side by side (no autoplay).
- Actions: Preview (modal player), Open folder (`library.openFolder`), Copy path (`library.copyPath` + toast),
  Approve / Reject (`jobs.setReview`), Regenerate (confirm, as in Queue).
### D — Admin (`screens/Admin.tsx`) — only rendered for admins
- Provider: status details (mode, state, origin, bridge URL, compatibility, hasApiKey, secretStoreAvailable),
  "Test connection". Bridge base URL + Muse platform origin fields (saved via `admin.updateSettings`), API key
  password field → `admin.setBridgeApiKey` (never displayed back; show "saved" state only), Clear key. If
  `secretStoreAvailable` is false show the setup error and disable saving.
- Prompt Master: list templates/versions, view body (read-only), "Save as new version" editor with note, quality
  report preview (`prompts.validate`), "Set as default".
- Categories editor (id/label/promptGroup), output root (library root), log retention days, admin users.
- Diagnostics: "Preview" (`admin.diagnosticsPreview` shown in a read-only `<pre>`) then "Export…"; "Run cleanup".

## Required tests (vitest + @testing-library/react, files `*.test.tsx` with `// @vitest-environment jsdom`)
- fakeApi implements every PodApi method (type-level via `satisfies PodApi` + a smoke test).
- Generate button: disabled until valid; double click → `jobs.create` called exactly once; uses the same
  clientRequestId if the component re-renders.
- SKU field shows error for `../x` and normalizes `ts-001` → `TS-001`.
- Duration/aspect controls hidden when capabilities are empty, shown when provided.
- Queue renders indeterminate state (no `%` text) when `progress` is null; renders only actions from `nextActions`.
- Ambiguous dialog never calls `jobs.retry`.
- Admin screen not rendered for non-admin.
