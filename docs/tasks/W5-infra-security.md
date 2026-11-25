# W5 — Config, secrets, logging, installer, CI and security docs

Read `docs/tasks/COMMON.md` first, then brief §0, §2.3, §2.4, §3.2, §9 (entire), §10 "Security tests", §12, §13.

## You own
- `src/main/infra/config/**`, `src/main/infra/secrets/**`, `src/main/infra/logging/**`,
  `src/main/infra/diagnostics/**`
- `electron-builder.yml`, `build/**` (installer resources: icon placeholder note, `installer.nsh` if needed)
- `.github/**`, `.gitleaks.toml`
- `docs/security/**`, `docs/architecture/adr-002-local-storage.md`, `docs/architecture/adr-003-security.md`,
  `docs/release/**`
- `README.md` (create; the lead will extend it at the end)

## Build
### 1. Config (`src/main/infra/config/`)
`loadConfig(args: { env: NodeJS.ProcessEnv; settings: Partial<AdminSettings>; paths: { userData: string;
documents: string }; isDev: boolean; envFilePath?: string }): AppConfig` (types in `@shared/config`).
- Read `.env` with `dotenv` only when `isDev` or when `envFilePath` is provided (`dotenv.parse`, never mutate
  `process.env` globally in tests). Admin settings override env defaults.
- zod validation + coercion of numbers with min/max bounds; on invalid values throw `PodError('CONFIG_INVALID')`
  with a message naming the key (never the value).
- `bridgeBaseUrl`: empty → null; otherwise must parse as URL with scheme http/https and hostname exactly
  `127.0.0.1`, `localhost` or `[::1]`; reject `0.0.0.0`, LAN IPs, public hosts, userinfo, query/fragment. Export
  `assertLoopbackUrl(url)` for reuse.
- `musePlatformOrigin`: empty → null, else must be an https origin (no path).
- `libraryRoot` default `<documents>/POD_VIDEO_LIBRARY`; `dataDir` = `<userData>` (local machine only). Reject a
  `dataDir` on a UNC path (`\\\\server\\share`). Library root may be a share only via the separate NAS adapter (not
  in MVP) — for now just warn in docs.
- Defaults: categories = `DEFAULT_CATEGORIES`, numbers as in `.env.example`, adminUsers from `POD_ADMIN_USERS`.
- `isAdmin(config, username)` helper: case-insensitive match; in dev with empty list → true.

### 2. Secrets (`src/main/infra/secrets/`)
`createSecretStore(deps: { safeStorage: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer;
decryptString(b: Buffer): string }; filePath: string }): SecretStore` — inject Electron's `safeStorage` (so it is
testable without Electron). Store ciphertext as base64 of the **encrypted** buffer in a JSON file with restrictive
mode. If `isEncryptionAvailable()` is false: `set` throws `PodError('SECRET_STORE_UNAVAILABLE')`, `get` returns null,
and **nothing is ever written in plaintext/base64-of-plaintext**. Corrupt file → treat as empty, do not crash.
Add `getBridgeApiKey(store, env, isDev)`: store first; env `MUSE_BRIDGE_API_KEY` only in dev.

### 3. Logging (`src/main/infra/logging/`)
`createLogger(opts: { dir: string; retentionDays: number; level?: 'debug'|'info'|'warn'|'error' }): Logger &
{ flush(): Promise<void> }` — JSON lines `{ts, level, event, ...fields}` to `<dir>/pod-YYYY-MM-DD.log`.
`redact.ts`: applied to every field: drop/replace keys matching
`/prompt|token|api[-_]?key|authorization|cookie|session|secret|password|signature|signed/i` with `"[REDACTED]"`;
in string values mask `Bearer \S+`, `sk-…`-style long tokens (≥24 chars base64/hex), URLs' query strings,
absolute Windows paths (`C:\…`, `\\server\…`) → `[PATH]`, user home dir. `cleanupLogs()` deletes files older than
retention and returns count. Export `redactText(s)` and `redactFields(f)` for reuse.

### 4. Diagnostics (`src/main/infra/diagnostics/`)
`buildDiagnostics(input: { appVersion; config: AppConfig; providerStatus: unknown; recentLogLines: string[];
jobCounts: Record<string, number> }): string` — human-readable report run entirely through `redactText`; include
OS/Electron/Node versions, config (with URLs host-only, no key; `hasApiKey` boolean), counts, last ~200 redacted log
lines. Opt-in: only produced when the admin requests a preview; export writes exactly the previewed text.

### 5. Installer + CI
- `electron-builder.yml`: appId `com.company.podvideostudio`, productName `POD Video Studio`, `win.target: nsis`,
  `nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
  deleteAppDataOnUninstall: false }` (preserve user data/library on uninstall/update), `files` limited to `out/**`
  + `prompts/**` (as `extraResources` to `prompts`), `asar: true`, signing via `CSC_LINK`/`CSC_KEY_PASSWORD` env
  (unsigned when empty), `publish: null` (no auto-update server in MVP), `directories.output: release`.
- `.github/workflows/ci.yml` on `windows-latest`: checkout, setup-node 24, `npm ci`, typecheck, lint, test,
  `npm audit --audit-level=high`, SBOM (`npx --yes @cyclonedx/cyclonedx-npm@<pinned version> --output-file sbom.json`
  uploaded as artifact), Gitleaks (download pinned release + verify SHA-256 before running), build. **Every
  third-party action pinned by full commit SHA** with a `# vX.Y.Z` comment. Use SHAs you can verify; if you cannot
  verify one offline, leave `# TODO pin SHA` and list it in your report — do not invent SHAs.
- `.gitleaks.toml` extending defaults, allowlisting `.env.example`.

### 6. Docs
- `docs/security/muse4ai-reference-review.md` — independent static review **based on brief §2** (do not clone or
  fetch the repo): findings, confidence, residual risks, explicit "not a malware-free certification".
- `docs/architecture/adr-002-local-storage.md` — SQLite (`node:sqlite`, WAL, local only), media library layout,
  NAS boundary.
- `docs/architecture/adr-003-security.md` — DPAPI via safeStorage fail-closed, loopback-only, logging redaction,
  installer/update/signing strategy, no tunnels.
- `docs/release/checklist.md` — signing, SBOM, audit, pilot on one isolated PC (§12).
- `README.md` — what the app is, `.env` keys table (all placeholders), dev commands, build installer command.

## Required tests
- Config: loopback accepted (`http://127.0.0.1:47821`, `http://localhost:1`, `http://[::1]:2`); rejected
  (`http://0.0.0.0:1`, `http://192.168.1.2:1`, `http://example.com`, `http://user:p@127.0.0.1`, `ftp://127.0.0.1`);
  number bounds; settings override env; error message never contains the bad value; UNC dataDir rejected.
- Secrets: encryption unavailable → `set` throws, file not created/contains no plaintext; available → round trip,
  file content does not contain the plaintext; corrupt file tolerated; dev env fallback only in dev.
- Logging: API key, bearer header, cookie, prompt field, signed URL query, absolute path all redacted in the written
  file; retention cleanup deletes old files only.
- Diagnostics: output contains no key/prompt/paths even when the inputs contain them.
