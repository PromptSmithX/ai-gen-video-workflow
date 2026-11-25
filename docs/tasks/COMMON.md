# Rules for every worker (read first)

You are one of several parallel workers building **POD Video Studio** (Electron + TypeScript + React).
The product brief is `POD_VIDEO_STUDIO_AGENT_BRIEF.md` at the repo root — read the sections your task cites.
The lead (Claude) reviews your branch, sends fixes back, and merges it into `main`.

## Stack and commands (already installed — do NOT run `npm install <pkg>`)
- Node 24 / Electron 45, TypeScript strict, Vite 8 via electron-vite, React 19, zod 4, vitest 5.
- SQLite = built-in `node:sqlite` (`DatabaseSync`). **Do not add better-sqlite3 or any native module.**
- `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`.
- Run `npm install` (no args) once if `node_modules` is missing in your worktree.
- Path aliases: `@shared/*` → `src/shared/*`, `@renderer/*` → `src/renderer/src/*` (renderer only).

## Hard rules
1. **Stay inside the paths your task owns.** Never edit `src/shared/**`, `package.json`, `package-lock.json`,
   tsconfig/vite/vitest/eslint configs, or another worker's folders. If you believe a shared contract or a
   dependency must change, ask the coordinator (`orca orchestration ask ...`) and wait for the answer.
2. Implement against the contracts in `src/shared/` exactly (`services.ts`, `provider.ts`, `ipc.ts`, `domain.ts`,
   `prompt.ts`, `job-state.ts`, `errors.ts`, `config.ts`). Import them with `@shared/...`.
3. Security (brief §0, §9): never log prompt text, image bytes, API keys, cookies, session ids, signed URLs or
   absolute user paths; loopback-only networking; no plaintext/base64 secret fallback; parameterized SQL only;
   no automatic resubmit after a request may have reached the provider.
4. Do **not** clone, download, install, run or copy code from `andrew-babo/muse4ai`. No browser automation,
   no undocumented provider endpoints, no other video provider.
5. No real network calls in tests. No `console.log` (lint forbids it) — use the Logger contract in main code.
6. Tests: vitest, co-located `*.test.ts` next to the code (or under `test/` where your task says). Use temp dirs
   (`fs.mkdtempSync(path.join(os.tmpdir(), 'pod-'))`) and clean them up.
7. Every URL / key / prompt that the company must supply stays a placeholder read from config/.env — never invent
   real values. Mark placeholders clearly with `PLACEHOLDER`.
8. Keep code readable: small modules, explicit types, no `any` unless justified in a comment.

## Definition of done (the lead checks all of these)
- `npm run typecheck`, `npm run lint`, `npm test` all pass in your worktree.
- Every test listed under "Required tests" in your task exists and passes.
- Only owned paths changed (`git diff --stat main...HEAD`).
- Work committed on your branch with clear messages (do not merge, rebase onto, or push to `main`).
- Finish by reporting with `worker_done`: summary, files changed, test counts, and anything left open.
