# ADR-001: Isolate the Muse integration behind `MuseProvider`

- Status: accepted
- Date: 2026-11-23

## Context
The production video must come from the same Muse generator employees already use (brief §0.1). There is no
documented public Muse video API; the only known integration shape is a separately approved **local bridge** with a
REST façade (brief §4), whose exact contract must be confirmed from its live `/v1/openapi.json`. The provider
origin, terms approval and bridge availability are still open. The reference project (muse4ai) hard-codes
`https://muse.ai` selectors that must not be assumed compatible.

## Decision
- All provider knowledge lives in `src/main/providers/muse`. Everything else depends only on the `MuseProvider`
  interface in `src/shared/provider.ts` (connection state, capabilities, generate, get job, download, optional
  cancel / lookup-by-request-id).
- Two implementations: `MockMuseProvider` (default, offline, used by all tests and demos) and
  `RestBridgeMuseProvider` (loopback-only REST client for the approved bridge). Selected by `PROVIDER_MODE`.
- No browser automation, no undocumented provider endpoints, no other video provider, no code copied from muse4ai.
- Capabilities come from the bridge; the UI hides anything not reported (duration, aspect, cancel, progress).
- Failures carry a `phase` (`before_submit` / `after_submit` / `unknown`). Only `before_submit` failures may ever be
  retried, and only manually. Anything uncertain becomes `AMBIGUOUS` and is never automatically resubmitted.
- A stable per-job UUID is sent as `Idempotency-Key`; retries of the same job reuse it.

## Consequences
- The UI, orchestrator and tests can be completed and verified before the bridge is approved.
- Adjusting to the real bridge contract touches only `providers/muse/endpoints.ts` + schemas.
- If the provider does not permit this integration, only the bridge implementation is dropped; the rest of the app
  (SKU library, Prompt Master, media management) remains usable.
