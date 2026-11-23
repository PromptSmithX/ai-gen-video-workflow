# Static Security & Architecture Review: Muse4AI Reference Repository

- **Target Repository:** `andrew-babo/muse4ai`
- **Reviewed Branch:** `main`
- **Reviewed Commit:** [`c661f83b8e7883e6fb1f16e1b584284818b26b29`](https://github.com/andrew-babo/muse4ai/commit/c661f83b8e7883e6fb1f16e1b584284818b26b29)
- **Observed Package Version:** `2.0.0-beta.35`
- **Declared License:** MIT
- **Review Date:** 2026-11-23
- **Review Type:** Independent static source inspection based on product brief §2 (conducted without cloning, downloading, installing, or executing the third-party repository).

---

## Executive Summary & Non-Certification Notice

An independent static source review was conducted on the reference repository `andrew-babo/muse4ai` at commit `c661f83` to assess architectural patterns, security controls, and potential supply-chain risks before designing POD Video Studio.

> [!WARNING]
> **Explicit Notice: This review is NOT a malware-free certification.**
> A complete binary audit, dynamic sandbox detonation, dependency tree scan on compiled binaries, and verification of historical commit lineages were not performed. The upstream binary installer and package artifacts must never be executed on company workstations or bundled directly into company software distributions.

**Conclusion:** The reference repository serves as a valuable **architectural reference** for module boundaries, provider abstraction, and desktop job coordination. However, due to Terms of Service, platform compatibility, and fallback security vulnerabilities, **no code from this repository is copied into POD Video Studio**.

---

## Inspected Source Files

The review analyzed key files across the reference codebase:
- **Repository Metadata:** `README.md`, `SECURITY.md`, `LICENSE`, `desktop/package.json`, `desktop/package-lock.json`.
- **Audit & CI:** `docs/audit/2026-11-06.md`, `.github/workflows/audit.yml`.
- **Main Process & Core Logic:** `desktop/AGENTS.md`, `desktop/src/main/main.ts`, `accounts.ts`, `vault.ts`, `db.ts`, `repo.ts`.
- **API & Networking:** `desktop/src/main/api/server.ts`, `controller.ts`, `service.ts`, `store.ts`, `childProc.ts`, `tunnel.ts`, `caddy.ts`, `updater.ts`.
- **Provider Automation Adapter:** `desktop/src/main/adapter/muse/driver.ts`, `selectors.ts`.
- **Shared Contracts & Validation:** `desktop/src/shared/api/schemas.ts`, `openapi.ts`, `keys.ts`, `netPolicy.ts`, `constants.ts`, `validate.ts`.
- **Packaging & Installation:** `desktop/installer/install.ps1`, `desktop/installer/setup.iss`.

---

## Positive Security Signals

1. **Responsible Disclosure & License:** Contains standard MIT licensing and a documented `SECURITY.md` vulnerability reporting process.
2. **Local Network Boundary Controls:** The internal `ApiServer` defaults to loopback-only binding (`127.0.0.1`), enforces bearer token authentication, request size limitations, rate limiting, and rejects cross-origin browser requests (`Origin` and `OPTIONS` handling).
3. **Cryptographic Token Handling:** API keys are generated using cryptographically secure random bytes. Tokens are stored as SHA-256 hashes rather than plaintext in the database.
4. **Electron Window Isolation:** Windows configured in the inspected main process enforce `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`.
5. **Database Parameterization:** SQL queries across inspected repository models utilize parameterized statements, preventing SQL injection vulnerabilities.
6. **Ambiguous State Mitigation:** The adapter explicitly avoids naive network retry loops when submit status is uncertain, preventing double-billing or duplicate provider generation.

---

## Critical Risks and Unresolved Questions

### 1. Provider Terms of Service (ToS) Compliance
The reference project automates a web application session rather than communicating with an official documented public API. This web automation strategy carries substantial risk of violating provider Terms of Service, triggering anti-bot protections, or causing account suspension.

### 2. Platform Compatibility Risk
The reference adapter hardcodes `https://muse.ai`, specific DOM selectors, and private session routes (`/api/session`, `/api/auth/check`, `/api/hatch/vm/wake`). These are internal implementation details subject to sudden breaking changes and do not guarantee compatibility with any internal or separate Muse enterprise service.

### 3. Insecure Vault Fallback (`plain:<base64>`)
When OS-backed DPAPI / Credential Manager encryption is unavailable, `desktop/src/main/vault.ts` falls back to storing secrets with prefix `plain:<base64>`. Base64 is an encoding, not encryption. POD Video Studio explicitly rejects this fallback and **fails closed** (`SECRET_STORE_UNAVAILABLE`).

### 4. Self-Referential Updater Trust Model
The reference auto-updater verifies downloaded SHA-256 checksums against a manifest hosted on the same publisher origin without a separate, cryptographically pinned code-signing authority.

### 5. Third-Party Outbound Network Calls
Inspected selectors include external IP lookup requests to `https://ipinfo.io/json`, alongside optional reverse proxy / tunnel components (Cloudflare Tunnels, Caddy). POD Video Studio strictly enforces loopback-only communication without external tunneling.

### 6. Substantial Unnecessary Attack Surface
The reference project contains multi-account rotation, OAuth servers, MCP agents, video extensions, and cloud relays. Porting these features would introduce unnecessary complexity and vulnerability exposure to POD Video Studio.

### 7. Audit Freshness Discrepancy
The historical audit file (`2026-11-06.md`) references version `2.0.0-beta.32` with 774 tests, whereas the active repository branch reflects `2.0.0-beta.35` with 848 tests. The audit cannot be considered valid for newer builds or release artifacts.

### 8. CI Workflow Supply Chain
The audit GitHub workflow uses unpinned major tags for GitHub Actions and downloads Gitleaks binary releases directly using `curl` without hash verification.

### 9. PowerShell Script Execution Bypass
Windows installer scripts invoke PowerShell with `-ExecutionPolicy Bypass`. While common for setup scripts, executing third-party scripts with bypassed execution policies presents administrative risk.

### 10. Lack of Dynamic Runtime Verification
Static source review cannot determine whether runtime binary artifacts, build dependencies, or bundled node modules contain vulnerabilities or unintended behavior.

---

## Architectural Decision for POD Video Studio

1. **Zero Source Code Ingestion:** Do not vendor, copy, or download source code from `andrew-babo/muse4ai`.
2. **Provider Boundary Isolation:** Define a clean, internal `MuseProvider` contract (`src/shared/provider.ts`). All provider communication happens either via an offline mock or an approved, loopback-only local bridge.
3. **Fail-Closed Secret Storage:** Enforce Windows DPAPI via Electron `safeStorage`. Never store credentials in plaintext or base64.
4. **Strict Redaction:** Filter all logs and diagnostics to ensure prompt text, credentials, image data, and local user paths are never leaked.
