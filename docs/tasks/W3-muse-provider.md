# W3 — Muse provider integration (mock + approved local REST bridge)

Read `docs/tasks/COMMON.md` first, then brief §0 (constraints + compatibility gate), §3.3, §4 (entire), §8, §10
"Integration tests with mocked provider".

## You own
- `src/main/providers/muse/**`
- `test/mock-bridge/**` and `test/integration/provider/**`
- `docs/api/muse-provider-contract.md`
- `docs/integration/platform-compatibility.md`

## Build
`src/main/providers/muse/index.ts` exports `createMuseProvider: MuseProviderFactory` (`@shared/services`):
returns `MockMuseProvider` when `config.providerMode === 'mock'`, otherwise `RestBridgeMuseProvider`.
Throw `ProviderError` (`@shared/provider`) for failures, always with a `phase`.

### 1. `MockMuseProvider` (`mock.ts`)
- Fully offline, deterministic, configurable scenario: `'success' | 'not_connected' | 'needs_login' | 'refused' |
  'quota' | 'provider_5xx' | 'ambiguous' | 'success_no_asset' | 'corrupt_mp4' | 'slow'` (constructor option; default
  `'success'`, and in dev it can be chosen with env `POD_MOCK_SCENARIO`).
- Idempotent: same `requestId` returns the same job (never creates a second one); counts generations so tests can
  assert "exactly one".
- Progresses queued → running → succeeded over a few `getJob` calls (or a time-based schedule); `reportsProgress`
  false by default (do not fabricate %).
- `downloadOutput` writes a tiny but valid MP4 (`ftyp` + `moov` + `mdat` boxes) — generate bytes in code, no binary
  fixture files. `corrupt_mp4` writes garbage; `success_no_asset` → `OUTPUT_MISSING`.
- `canCancel: true` in the mock so the UI path can be tested; implement `cancelJob`.
- `findJobByRequestId` implemented.

### 2. `RestBridgeMuseProvider` (`rest-bridge.ts` + `http.ts` + `mapping.ts`)
Contract (brief §4; NOT an official Muse API — it is the approved local bridge):
- Base URL from `config.bridgeBaseUrl`; **refuse to construct/issue requests unless the host is `127.0.0.1`,
  `localhost` or `[::1]` and scheme `http`/`https`** (`UNSUPPORTED_PLATFORM`/`NOT_CONNECTED` safe errors).
  Never scan ports. No redirects followed (`redirect: 'manual'`, treat 3xx as error).
- Auth: `Authorization: Bearer <getApiKey()>`; key is read per request, never logged, never in error messages.
- `getConnectionState`: `GET /v1/health` (unauthenticated) → if unreachable `not_installed`; then `GET /v1/status`
  → map to ProviderConnectionState (401/403 → `error` with safe msg; login-required flag → `needs_login`; quota flag
  → `quota_limited`). Parse defensively with zod; unknown shapes → `error`.
- `getCapabilities`: derive from `/v1/status` capabilities if present; otherwise conservative defaults
  (`canCancel:false`, `reportsProgress:false`, no durations/aspects, `maxPromptChars:4000`,
  `maxUploadBytes:20 MiB`). Cache for 60 s.
- `generateVideo`:
  1. Pre-checks (connection state, prompt length ≤ maxPromptChars, file size ≤ maxUploadBytes) — failures here are
     `phase:'before_submit'`.
  2. `POST /v1/references` raw bytes, `Content-Type` = real mime, `X-File-Name` = safe base name. Failures here are
     `before_submit` (no generation requested yet).
  3. `POST /v1/jobs` JSON `{kind:'video', mode:'reference', prompt, reference_id, repeat:1, account:'auto'}` with
     `Idempotency-Key: requestId`. Outcomes:
     - connection refused / DNS / socket error **before any byte was sent** → `before_submit` `NOT_CONNECTED`;
     - 202/200 with job id(s) → state `queued`/`running`, return providerJobId (+ referenceId);
     - 4xx refusal/quota/login → `FAILED_*` mapping (`CONTENT_REFUSED`, `QUOTA_LIMITED`, `NEEDS_LOGIN`) with
       phase `before_submit` only when the bridge explicitly says nothing was submitted, else `after_submit`;
     - timeout, reset after send, 5xx, unparsable 2xx → return `{state:'ambiguous', providerJobId:''}` with
       `errorCode:'SUBMIT_AMBIGUOUS'`. **Never resend.** Use a single attempt only.
  4. `findJobByRequestId(requestId)`: only if the bridge OpenAPI exposes a lookup (e.g. `GET /v1/jobs?idempotency_key=`)
     — implement behind a capability flag, default unsupported → throw `ProviderError('SUBMIT_AMBIGUOUS','unknown')`.
- `getJob`: `GET /v1/jobs/{id}` (id URL-encoded + validated charset), map states; progress only if numeric and
  provided.
- `downloadOutput`: get the asset URL/id from the job; **accept only URLs whose origin equals the bridge origin**
  (or build `GET /v1/assets/{id}/download` yourself); stream to `destPath` with a byte cap (abort + delete when
  exceeded), `OUTPUT_MISSING` when no asset, `DOWNLOAD_FAILED` on HTTP/stream errors. Caller validates MP4 + hash.
- `cancelJob` only defined when capability `canCancel` is true.
- Endpoint paths and field names live in ONE `endpoints.ts` + zod schemas file so they can be adjusted after the
  real `/v1/openapi.json` is read. Mark assumptions with `// ASSUMPTION (verify against live /v1/openapi.json)`.
- Polling helper `poll.ts`: `nextPollDelay(attempt, base, max)` bounded exponential backoff with jitter — used by
  the orchestrator; export it.
- Logging: only event names + jobId/requestId/status codes/durations. Never prompt, key, URLs with query strings.

### 3. Mock bridge (`test/mock-bridge/server.ts`)
A tiny `node:http` server bound to `127.0.0.1` on port 0 implementing the endpoints above with switchable
behaviours (healthy, needs_login, quota, refused, 5xx, hang-after-request-body (for ambiguous), success,
success-no-asset, truncated download, oversized download, redirect-to-foreign-host, asset URL on foreign host).
Checks bearer auth, records every request so tests can assert counts. Used by your integration tests and later by W6.

### 4. Docs
- `docs/api/muse-provider-contract.md`: the exact assumed request/response examples, error mapping table,
  idempotency + ambiguous semantics, what must be verified against the live `/v1/openapi.json`.
- `docs/integration/platform-compatibility.md`: actual Muse origin = `TODO (MUSE_PLATFORM_ORIGIN in .env)`,
  bridge method, capability table, terms approval status = **NOT APPROVED / pending**, rule: if origin ≠
  approved bridge's provider, mark not compatible (brief §0 gate).

## Required tests (`test/integration/provider/*.test.ts` against the mock bridge + unit tests)
- Non-loopback base URL (`http://192.168.1.5:47821`, `http://example.com`) rejected without any request.
- Health unreachable → `not_installed`; login required → `needs_login`; status 401 → safe error, key not in message.
- Upload then submit exactly one job (assert server saw 1 `POST /v1/jobs`, with Idempotency-Key = requestId and
  raw image bytes on `/v1/references`).
- queued → running → succeeded via getJob; refusal; quota; 5xx on submit → ambiguous (no second POST).
- Network interruption before submit (server closed) → `before_submit` `NOT_CONNECTED`.
- Server hangs after receiving the job body → timeout → `ambiguous`, exactly 1 POST recorded.
- Success but no asset → `OUTPUT_MISSING`; truncated/oversized download → `DOWNLOAD_FAILED` and `.part` deleted;
  foreign-host asset URL and redirect rejected.
- Mock provider: idempotent per requestId, each scenario maps to the expected state/error, MP4 bytes start with `ftyp`.
- `nextPollDelay` bounded and increasing.
- A log-capture test proving the API key and prompt never appear in log output or error messages.
