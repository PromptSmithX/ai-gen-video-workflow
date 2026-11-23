# ADR-002: Local Storage Architecture (SQLite, Media Library, and NAS Boundary)

- **Status:** Accepted
- **Date:** 2026-11-23
- **Context:** Brief §0, §7, §9, §13

---

## Context and Problem Statement

POD Video Studio requires persistent storage for:
1. Application metadata: SKU definitions, product details, jobs, state transitions, prompt templates, and administrative settings.
2. Large binary assets: Original product mockup images (PNG/JPEG/WEBP, up to 15 MB) and generated product review videos (MP4, up to 500 MB).
3. Audit artifacts: Rendered prompt snapshots and job execution metadata.

Enterprise environments frequently attempt to host desktop SQLite databases and active scratch spaces on networked shares (e.g., Windows UNC paths or SMB/NFS mounts). This practice causes database lock contention, WAL file corruption, severe filesystem latency, and application instability.

---

## Decision

### 1. SQLite for Local Metadata (`node:sqlite` / `DatabaseSync`)
- We use Node 24's built-in `node:sqlite` (`DatabaseSync`). Native add-ons such as `better-sqlite3` are strictly forbidden.
- The SQLite database is configured in **WAL (Write-Ahead Logging)** mode for concurrent read/write performance.
- The database file and all transient working files must reside exclusively on **local machine storage** (`dataDir = paths.userData`).
- **UNC paths (`\\server\share`) are strictly rejected** during configuration loading (`CONFIG_INVALID`).

### 2. SKU Media Library Layout
All digital assets are organized deterministically under the configured `libraryRoot` (`<Documents>/POD_VIDEO_LIBRARY` by default):

```text
POD_VIDEO_LIBRARY/
  <SKU>/
    source/
      <SKU>-original[-N].<ext>    # Unaltered, byte-identical source mockup
    prompts/
      <SKU>-prompt-<label>.md     # Snapshot of prompt submitted to provider
    videos/
      <SKU>-video-NNN.mp4         # Atomically stored, validated MP4 video
    metadata/
      <SKU>-video-NNN.json        # Sanitized execution metadata & digests
```

### 3. File Validation & Atomic Storage
- **Source Images:** Validated by real file magic bytes (PNG, JPEG, WEBP), file size (capped at 15 MB), and pixel resolution bounds (capped at 50,000,000 pixels). Source artwork is never compressed or altered.
- **Downloaded Videos:** Stored first into a private temp directory with a `.part` extension, verified against MP4 container signatures and SHA-256 checksums, and atomically moved into `videos/<SKU>-video-NNN.mp4`.
- **Path Traversal Protection:** Relative file paths are resolved against `libraryRoot` with strict containment checks to prevent symlink and traversal attacks (`..`).

### 4. Enterprise NAS Boundary
- The core desktop application operates exclusively against local storage.
- Sharing media with enterprise file repositories or network-attached storage (NAS) is handled exclusively via a separate, future export/synchronization adapter.
- Under no circumstances will SQLite database files or temporary `.part` download streams be opened directly over a network share.

---

## Consequences

### Positive
- **Integrity & Stability:** Eliminates SMB/CIFS file-locking race conditions and SQLite WAL corruption.
- **Performance:** Local SSD operations provide sub-millisecond database queries and fast atomic file renames.
- **Clean Audit Trail:** Every video is irrevocably tied to its exact source image, prompt snapshot, and SHA-256 hash.

### Negative / Trade-offs
- Multi-device synchronization requires an asynchronous export workflow rather than opening a shared network file.
