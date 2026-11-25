# W2 — Prompt Master manager

Read `docs/tasks/COMMON.md` first, then brief §1 "Product principles" and §6 (entire section).

## You own
- `src/main/prompts/**`
- `prompts/**` (repo root folder with built-in templates)
- `docs/prompts/prompt-master-versioning.md`

## Build
### 1. Template files (`prompts/`)
```
prompts/
  master/product-review-v1.md        # PLACEHOLDER
  master/product-review-v2.md        # PLACEHOLDER (default)
  categories/apparel.md
  categories/drinkware.md
  categories/home-decor.md
  categories/other.md
  schema.json                        # JSON schema of the frontmatter
```
Each master file has YAML-like frontmatter (parse it yourself — simple `key: value` lines between `---` markers, no
new dependency):
```
---
id: product-review
version: v2
title: Product review (PLACEHOLDER)
placeholder: true
created_at: 2026-11-23
note: Replace with the company-approved Prompt Master V2 text.
---
```
**Do not invent the company's Prompt Master.** The body must start with a clear banner line such as
`[PLACEHOLDER PROMPT MASTER — replace with the company-approved text via PROMPT_MASTER_PATH or Admin]`, then a
reasonable generic structure using the allowed variables (`{{sku}}`, `{{product_category}}`, `{{product_name}}`,
`{{review_style}}`, optional `{{duration_seconds}}`, `{{aspect_ratio}}`) and a "Rules" block that satisfies every
quality check below, plus a `{{category_rules}}` insertion point for the category snippet. (`category_rules` is an
internal slot, not a user variable.)
Category snippets add realistic handling notes per group (fabric drape/folds for apparel; rigid body, reflections,
lid for drinkware; etc.) without authorizing any artwork changes.

### 2. Service (`src/main/prompts/`)
`index.ts` exports `createPromptService(opts: { builtinDir; adminDir; companyMasterPath })` → `PromptService`
(`@shared/services`). Sources:
- builtin: `<builtinDir>/master/*.md` (source `'builtin'`)
- company: if `companyMasterPath` is set and readable, load it as template id `product-review`, version from its
  frontmatter or `company-<sha256 first 8>` if none, source `'company'`, `isPlaceholder=false`, and it becomes the
  default. Missing/unreadable file → keep builtin placeholder and expose a warning flag (no crash).
- admin: `<adminDir>/<id>/<version>.md` written by `saveTemplateVersion` (source `'admin'`). New version name =
  `v<N+1>` over all known versions of that id; never overwrite an existing file (use `wx` flag). Persist the
  default selection in `<adminDir>/default.json`.
Rendering (`renderer.ts`):
- Placeholder syntax `{{name}}` with optional whitespace. Unknown names → error
  `Unknown placeholder: {{name}}` (do not render). Unclosed `{{` → error.
- Values are plain text: strip control chars, collapse newlines in single-line vars, and neutralize any `{{`/`}}`
  inside values so a SKU/file name can never inject template syntax. Single pass (no recursive expansion).
- `duration_seconds` / `aspect_ratio` lines: if the provider does not support them (`supportsDuration` /
  `supportsAspectRatio` false) or value is missing, remove the whole line containing that placeholder.
- Optional vars missing (`product_name`, `review_style`) → remove the line containing them.
- `source_image_filename` is metadata only — strip any directory part, keep base name.
- Result `RenderedPrompt` with `chars`, `maxChars`, `errors` (add `PROMPT_TOO_LONG`-style message when over limit),
  `quality` from the checker, `isPlaceholder`.
Quality checker (`quality.ts`): each `QualityRuleId` has a label and a set of accepted phrasings (case-insensitive,
keyword groups — e.g. preserve_artwork passes if the text says to keep/preserve the exact design/artwork/print);
`validatePrompt(text, maxChars)` reuses it for employee overrides. Keep rule phrases in one table so admins can
read them. Failing checks are reported, not auto-fixed.

### 3. Docs
`docs/prompts/prompt-master-versioning.md`: how company Prompt Master versions are imported (PROMPT_MASTER_PATH or
Admin "save new version"), reviewed (quality checks + diff), set as default, and rolled back (set default to an
older version; files are immutable). State clearly that the shipped text is a placeholder.

## Required tests
- Frontmatter parsing incl. missing fields → sensible defaults / errors.
- Lists builtin v1+v2; default is v2 placeholder; company file overrides default and is not placeholder.
- Missing company file → no crash, placeholder remains default.
- Render replaces all variables; unknown placeholder rejected; unclosed braces rejected.
- Injection: SKU or product name containing `{{sku}}` / `}}{{x` is rendered literally-neutralized, no expansion.
- Duration/aspect lines removed when unsupported; kept when supported and provided.
- Over-length prompt → error, `chars` reported.
- Quality checker: shipped placeholder v2 passes all checks; a "slow zoom on the image" prompt fails
  `human_review_action` and `preserve_artwork`; fake-claims rule detects missing prohibition.
- saveTemplateVersion creates v3 without touching v2; second save creates v4; setDefault persists across a new
  service instance.
