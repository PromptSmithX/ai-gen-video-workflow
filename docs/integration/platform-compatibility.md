# Platform Compatibility and Terms Approval Gate

_Status: Review in progress (Phase 0)._  
_Reference Brief: Section 0 (Compatibility Gate) and Section 13._

---

## 1. Provider Origin and Identification

| Parameter | Configuration | Status |
|---|---|---|
| Configured Origin Key | `MUSE_PLATFORM_ORIGIN` | Placeholder in `.env.example` |
| Actual Production Muse Origin | `TODO (MUSE_PLATFORM_ORIGIN in .env)` | **PENDING COMPANY INPUT** |
| Reference Project Origin (`muse4ai`) | `https://muse.ai/` | Architecture reference only (NOT APPROVED) |

### Non-Negotiable Gate Rule (Brief §0)
> The reference repository hard-codes `https://muse.ai/`. If the actual Muse product that company employees use is **not** hosted on `https://muse.ai`, the reference project's automation adapter is **strictly NOT COMPATIBLE**.
>
> If the origin differs or provider terms prohibit automation, stop provider bridge integration and operate in standalone mode (independent UI, prompt library, SKU manager, and offline Mock provider).

---

## 2. Integration Method

- **Approved MVP Integration Method**: Locally running approved REST bridge listening strictly on `127.0.0.1`.
- **Local FAÇADE Contract**: Documented in `docs/api/muse-provider-contract.md`.
- **Forbidden Methods**:
  - No scraping, reverse engineering, or cookie extraction.
  - No headless browser automation or undocumented remote provider endpoints.
  - No third-party network relays, public tunnels (Cloudflare tunnel/ngrok), or LAN listeners.

---

## 3. Terms of Service & Legal Approval

| Item | Requirement | Status |
|---|---|---|
| Provider Terms Review | Verify automated generation against live Muse Terms | **NOT APPROVED / PENDING** |
| Account Policy | Employee signs in individually via normal provider UI; no shared accounts | In compliance |
| Security & Privacy | No credential capture, no plaintext secrets, loopback-only | In compliance |
| Artwork Preservation | No unauthorized alteration of company designs | In compliance |

---

## 4. Bridge Capability Matrix

Capabilities dynamically discovered via `GET /v1/status` (cached for 60 s), falling back to conservative defaults:

| Capability | Conservative Default | Bridge Exposed | UI Adaptation |
|---|---|---|---|
| Duration Control (`supportedDurations`) | `[]` (empty) | If reported (e.g. `[5, 10]`) | UI hides duration selector if empty |
| Aspect Ratio Control (`supportedAspectRatios`) | `[]` (empty) | If reported (e.g. `9:16`, `16:9`) | UI hides aspect selector if empty |
| Cancel Job (`canCancel`) | `false` | As reported by bridge | Cancel button disabled/hidden if false |
| Progress Reporting (`reportsProgress`) | `false` | As reported by bridge | Indeterminate progress bar if false (never fabricate %) |
| Max Prompt Chars (`maxPromptChars`) | `4000` | As reported by bridge | Client-side validation prior to submit |
| Max Upload Bytes (`maxUploadBytes`) | `20 MiB` (20,971,520 bytes) | As reported by bridge | Client-side image validation prior to submit |
| Lookup by RequestId | `false` | As reported by bridge | AMBIGUOUS jobs reconciled if supported |

---

## 5. Decision & Next Steps

1. Company admin must supply the true employee-facing Muse domain into `MUSE_PLATFORM_ORIGIN`.
2. Company legal/product team must approve the bridge usage under current provider terms prior to production rollout.
3. Until both gates are cleared, the application runs with `PROVIDER_MODE=mock` (`MockMuseProvider`), guaranteeing full functionality for UI, prompt management, and SKU catalog testing without external dependencies.
