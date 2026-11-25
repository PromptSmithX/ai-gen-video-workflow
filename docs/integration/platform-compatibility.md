# Platform Compatibility and Terms Approval Gate

_Last updated: 2026-11-24 — origin confirmed by the product owner, bridge contract verified live._

## 1. Provider origin

| Parameter | Value | Status |
|---|---|---|
| `MUSE_PLATFORM_ORIGIN` | `https://muse.ai` | **Confirmed** by product owner (2026-11-24) |
| Muse4AI adapter origin | `https://muse.ai/` (hard-coded in Muse4AI) | Matches → compatible |

## 2. Integration method

- **Bridge:** Muse4AI desktop app (`andrew-babo/muse4ai`, MIT). Since 2026-11-25 a **patched build ships inside the
  POD installer** (`resources/muse4ai`, pinned commit + `vendor/muse4ai/patches`) and POD starts/provisions it
  (`src/main/infra/muse4ai/supervisor.ts`); the employee only signs in to muse.ai. See README › First run.
  Agent API on `http://127.0.0.1:47821`, mode **"Chỉ máy này / This machine only"** (no LAN, tunnel or public domain).
- **Contract:** Muse4AI agent API **2.0.0-beta.35**, snapshot `docs/api/bridge-openapi.json`; implementation in
  `src/main/providers/muse/{endpoints,mapping,rest-bridge}.ts`. Re-verify when Muse4AI changes version.
- **Auth:** per-agent key `msk_…` (scope `generate`) created in Muse4AI › Settings › API & agent; stored via Admin (DPAPI)
  or `MUSE_BRIDGE_API_KEY` in dev `.env`.
- **Proxy:** Muse4AI requires a healthy proxy per Muse account and never connects directly. The bundled build runs a
  loopback-only forward proxy inside Muse4AI (`127.0.0.1:8080`, `MUSE4AI_PROXY_PORT`), so traffic leaves through the
  employee's own network exactly as a browser would. (`npm run local-proxy` remains for a hand-run Muse4AI.)
- **Local patches:** `0001` treats Muse's `vm_state: "UNKNOWN"` as usable (upstream paused accounts after three
  20-second wake retries); `0002` adds `--pod-bootstrap` / `--pod-login`, `pod: true` in `/v1/health`, auto-update off.
  Neither changes how Muse4AI talks to muse.ai beyond that state check.
- POD Video Studio itself still opens no listener, does no browser automation and talks only to the loopback bridge.

### Submit mode (`MUSE_SUBMIT_MODE`, default `chat`)
Muse4AI's video job caps the prompt at **4000 chars** (`PROMPT_MAX = 4000`, a Muse4AI default — muse.ai itself accepts
longer prompts). The company T-shirt Master V2 is ~10 900 chars, so the default path is **chat**:
`POST /v1/jobs {kind:"chat", prompt, attachments:[reference_id], account:"auto"}` (≤ 32000 chars). Muse4AI sends the
prompt verbatim with the mockup attached — the same as pasting it into muse.ai — and returns every file Muse
produced in `outputs[]`; the video output is downloaded as usual.

Risks: Muse may answer a chat turn with text only → the job ends `FAILED_PROVIDER` / `OUTPUT_MISSING` (never
resent; check the conversation in Muse4AI). All jobs on one Muse account share that account's Muse memory.
`MUSE_SUBMIT_MODE=video` switches back to the video job (prompt must be ≤ 4000 chars).

### Prompt Master
Company T-shirt Master V2: `prompts/company/tshirt-review-v2.md` (`tshirt-review` v2), loaded via `PROMPT_MASTER_PATH`
and preselected on the Create screen. Other categories still use the built-in placeholder until their prompts exist.

## 3. Terms of service

| Item | Status |
|---|---|
| Muse4AI drives the Muse web app with the user's own signed-in session (browser automation by a third-party tool) | **Accepted by product owner** for testing; review Muse terms before company-wide rollout |
| One account per employee, signed in by the employee inside Muse4AI | Required |
| Company-wide rollout of the bundled Muse4AI (automation of muse.ai on every employee PC) | **Pending product-owner approval** — muse.ai disconnected a test account once (2026-11-24) |

## 4. Capability matrix (from `GET /v1/status`, cached 60 s)

| Capability | Muse4AI | POD Video Studio behaviour |
|---|---|---|
| Video from image | `capabilities.video_from_image` | Must be `true`, otherwise provider state `error` |
| Duration / aspect ratio | Not in `CreateJob` (`additionalProperties: false`) | Not sent; UI hides the controls. Muse clips are ~8–10 s |
| Progress % | Not reported | Indeterminate progress only |
| Cancel | `POST /v1/jobs/{id}/cancel` | Enabled for keys with scope ≠ `status` |
| Prompt limit | `limits.prompt_max_chars` (4000) | Validated before submit |
| Upload limit | `limits.upload_max_bytes` (20 MiB, ≤ 8192 px/edge) | Validated before submit |
| Lookup by Idempotency-Key | Not available | Ambiguous submit without a job id stays AMBIGUOUS for a person to check |

## 5. State mapping

| Muse4AI `status` | Provider state | Job state |
|---|---|---|
| `queued` / `running` | queued / running | RUNNING (keep polling) |
| `succeeded` (video in `outputs[]`) | succeeded | DOWNLOADING → SUCCEEDED |
| `failed` + `error.code` | failed | `QUOTA_LIMIT` → FAILED_QUOTA, `CONTENT_REFUSED` → FAILED_REFUSED, others → FAILED_PROVIDER |
| `needs_review` (or any unknown status) | ambiguous | AMBIGUOUS — never resent; "Check again" re-reads the job after the user resolves it in Muse4AI |
| `cancelled` | cancelled | CANCELLED |

Connection state: ready account with quota → `ready`; all accounts `exhausted`/`weekly_full` → `quota_limited`;
busy/waiting → `busy`; no accounts or `needs_user` → `needs_login`.
