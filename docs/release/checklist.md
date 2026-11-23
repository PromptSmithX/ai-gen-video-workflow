# Release & Deployment Security Checklist

This checklist defines the mandatory gates before any release of **POD Video Studio** can be certified and deployed to employee workstations.

Reference: Product Brief §0, §9, §10, §12.

---

## 1. Code Quality & Test Verification

- [ ] **Typecheck:** `npm run typecheck` passes with zero errors on both Node (`tsconfig.node.json`) and Web (`tsconfig.web.json`).
- [ ] **Linting:** `npm run lint` passes cleanly with zero ESLint errors or warnings.
- [ ] **Test Suite:** `npm test` runs all unit and integration tests successfully.
- [ ] **No Native Modules:** Confirm `node:sqlite` (`DatabaseSync`) is used; verify no `better-sqlite3` or native C++ modules are bundled.
- [ ] **No Provider Leaks in Tests:** Vitest runs with offline mocks only; no tests make live network calls or consume generation quota.

---

## 2. Security Audits & Supply Chain Integrity

- [ ] **Dependency Audit:** Run `npm audit --audit-level=high` and confirm zero High or Critical vulnerabilities.
- [ ] **Software Bill of Materials (SBOM):** Generate and attach CycloneDX SBOM artifact:
  ```powershell
  npx --yes @cyclonedx/cyclonedx-npm@1.19.0 --output-file release/sbom.json
  ```
- [ ] **Secret Scanning:** Run Gitleaks scan against git history and working tree using `.gitleaks.toml`:
  ```powershell
  gitleaks detect --source . -v --config .gitleaks.toml
  ```
- [ ] **Action Pinning:** Verify all GitHub Actions in `.github/workflows/` are pinned by full 40-character commit SHAs.

---

## 3. Configuration & Cryptographic Storage Checks

- [ ] **DPAPI Encryption Verification:** Verify `createSecretStore` fails closed when DPAPI is unavailable. Confirm no plaintext or base64 plaintext fallback exists in any secret store path.
- [ ] **Loopback Boundary:** Confirm `assertLoopbackUrl` enforces `127.0.0.1`, `localhost`, or `[::1]`, and rejects `0.0.0.0`, LAN IPs, and external domains.
- [ ] **Redaction Verification:** Verify that log files in `pod-YYYY-MM-DD.log` contain no prompt text, tokens, cookies, signed URLs, or user paths.
- [ ] **No Committed Secrets:** Verify `.env` is absent from git and `.env.example` contains only `PLACEHOLDER` values.

---

## 4. Packaging & Code Signing

- [ ] **Windows Authenticode Signing:** Ensure release build is signed using the company certificate:
  - `CSC_LINK` set to approved `.pfx` certificate path / base64 string.
  - `CSC_KEY_PASSWORD` supplied securely via environment variable.
- [ ] **Verify Signature:** Verify digital signature on generated installer:
  ```powershell
  Get-AuthenticodeSignature "release\POD Video Studio Setup *.exe"
  ```
- [ ] **Verify Installer Properties:**
  - Standard user install (no UAC elevation required).
  - Data directory preserved across updates (`deleteAppDataOnUninstall: false`).
  - ASAR archive enabled (`asar: true`).

---

## 5. Isolated PC Pilot Test

Before broad rollout to employees:
- [ ] **Install on Clean Windows 11 PC:** Execute installer on a non-developer, standard-user test machine.
- [ ] **First Launch:** Confirm app launches without Windows SmartScreen warnings (valid company certificate).
- [ ] **Offline Mock Verification:** Verify mockup upload, SKU input, template selection, and mock generation succeed.
- [ ] **Log & Data Inspection:** Confirm database is created in local `AppData\Roaming\pod-video-studio` and library in `Documents\POD_VIDEO_LIBRARY`. Verify no logs contain sensitive user data.
- [ ] **Uninstall / Upgrade Test:** Perform test update and verify existing library folders and SQLite database are fully intact.
