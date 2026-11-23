# ADR-003: Security Architecture (Credentials, Network Boundary, Logging, and Packaging)

- **Status:** Accepted
- **Date:** 2026-11-23
- **Context:** Brief §0, §2.3, §2.4, §9, §12

---

## Context and Problem Statement

POD Video Studio processes proprietary product mockups, connects to local provider bridges, and generates commercial video assets. A robust security posture is required to prevent:
1. Plaintext credential leakage on developer and employee workstations.
2. Remote unauthorized network access to local integration endpoints.
3. Accidental logging of customer artwork, prompt engineering intellectual property, or session credentials.
4. Supply chain vulnerabilities and unsigned executable delivery.

---

## Decision

### 1. OS-Backed Credential Storage (DPAPI Fail-Closed)
- Bridge API keys and sensitive tokens are encrypted using Windows Data Protection API (DPAPI) via Electron's `safeStorage`.
- Ciphertext is stored as base64-encoded encrypted buffers in a restricted JSON file (`mode: 0o600`).
- **Fail-Closed Policy:** If OS encryption is unavailable (`isEncryptionAvailable() === false`), the application throws `PodError('SECRET_STORE_UNAVAILABLE')` and refuses to persist credentials.
- **No Plaintext Fallback:** Base64 or obfuscated plaintext fallback is strictly forbidden.
- In production, environment variable fallbacks are ignored; `MUSE_BRIDGE_API_KEY` in environment variables is permitted only in `isDev` mode.

### 2. Loopback-Only Network Boundary
- The application connects exclusively to loopback interfaces (`127.0.0.1`, `localhost`, `[::1]`).
- URLs with non-loopback hostnames (e.g., `0.0.0.0`, LAN IPs `192.168.x.x`, public hostnames) or non-http(s) schemes are rejected with `CONFIG_INVALID`.
- Reverse proxies, Caddy servers, Cloudflare tunnels, and external relays are prohibited in MVP.

### 3. Automated Logging Redaction
- All log events pass through `redactFields` and `redactText` before writing to `<dataDir>/pod-YYYY-MM-DD.log`.
- Sensitive keys (`prompt`, `token`, `apiKey`, `authorization`, `cookie`, `session`, `secret`, `password`, `signature`, `signed`) are replaced with `"[REDACTED]"`.
- Substrings in text values are scrubbed: Bearer tokens, long hex/base64 tokens, URL query strings, absolute Windows paths (`[PATH]`), and user home directories (`[PATH]`).
- Automatic log retention cleanup deletes logs older than `logRetentionDays` (default 30 days).

### 4. Opt-in Diagnostics
- System diagnostics are generated only upon explicit administrative request.
- Config output reveals host-only endpoints (no paths or query parameters) and displays a `hasApiKey` boolean instead of secrets.
- The entire diagnostics output is scrubbed with `redactText`.

### 5. Packaging, Code Signing & CI Integrity
- **Packaging:** Packaged as a standard per-user Windows NSIS installer (`electron-builder.yml`) with `allowElevation: false`, `oneClick: false`, and `deleteAppDataOnUninstall: false` to ensure user library data is preserved across upgrades and uninstalls.
- **Signing:** Windows binaries and installers must be signed with the company's Authenticode certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`).
- **CI Supply Chain:** All third-party GitHub Actions are pinned to full commit SHAs. Automated steps include `npm audit --audit-level=high`, CycloneDX SBOM generation, and Gitleaks secret scanning.

---

## Consequences

- Prevents credential exposure in repository commits, system logs, or unprivileged processes.
- Shields local bridges from lateral movement across the company LAN.
- Ensures tamper-evident, reproducible, and verifiable Windows installation packages.
