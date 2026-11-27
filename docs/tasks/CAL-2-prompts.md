# CAL-2 — Calendar prompt template and category snippet

Read `docs/tasks/COMMON.md`, then `docs/tasks/CAL-COMMON.md`, then brief `calendar-category-integration.md`
§3.2–3.4, §7.5, §8, §13 "Domain / config / prompts". Also read `docs/tasks/W2-prompts.md` (how the prompt service
works) and the existing code in `src/main/prompts/`.

## You own
- `prompts/master/calendar-review-v1.md` (new), `prompts/categories/calendar.md` (new), `prompts/schema.json`
- `src/main/prompts/**`
- `docs/prompts/prompt-master-versioning.md` (add a short Calendar section)

## Build
1. `prompts/master/calendar-review-v1.md`: frontmatter `id: calendar-review`, `version: v1`, `placeholder: true`,
   title containing `(PLACEHOLDER)`, banner line first. Start from the draft in brief §8; use only supported
   variables (`PROMPT_VARIABLES`) plus `{{category_rules}}`. Requirements in brief §3.4 / §7.5 (one page turn around
   top spiral, blank warm-cream matte interior with no text/dates/numbers/illustrations, page flat/front-facing/
   unobstructed ≥ 2–3 s, hands on outer edges, four page edges visible with contrast to background, no strong camera
   zoom/orbit while open, preserve exact front cover, no fake claims/badges/subtitles).
   Check how `default:` frontmatter is interpreted today — the calendar template must **not** become the global
   default template and must not displace `product-review` (or the company T-shirt Master) as default.
2. `prompts/categories/calendar.md`: brief §3.3 / §8 snippet.
3. The template must pass all 8 existing quality rules (`src/main/prompts/quality.ts`). If a rule only matches
   garment/fabric wording, make the **rule pattern** neutral (e.g. accept paper/material texture) without making the
   apparel templates fail or the negation tests pass wrongly. Do not weaken any rule.
4. `PromptService.getTemplate('calendar-review')` must resolve to an admin/company version of `calendar-review` if one
   exists, otherwise builtin `v1`. Keep `isPlaceholder: true` for the builtin — never drop the flag to hide warnings.
   The company master path (`companyMasterPath`) stays bound to `product-review` only.

## Required tests
- `calendar-review` v1 listed, loads, `isPlaceholder === true`, not the default template; `product-review` /
  company default unchanged (existing tests untouched and green).
- Rendering with `categoryGroup: 'calendar'` appends `calendar.md` content; all variables resolve; no unknown
  placeholder.
- Rendered calendar prompt contains blank-interior-page requirement and exact front-cover preservation, and forbids
  generating text/dates/illustrations on the interior page.
- `checkQuality(calendar body)` passes all 8 rules; apparel v1/v2 still pass; negation tests still behave.
- Admin-saved `calendar-review` v2 becomes what `getTemplate('calendar-review')` returns when set default for that id
  (follow existing admin default semantics; document what you chose).

## Definition of done
`npm run typecheck`, `npm run lint`, `npm test` pass; only owned paths changed vs `dev`; `worker_done` report.
