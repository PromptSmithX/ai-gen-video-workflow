# ADR-004: Local Calendar Artwork Compositor Architecture

- **Status:** Accepted
- **Date:** 2026-11-25
- **Context:** Feature brief `calendar-category-integration.md` §7, §11, §12 W-CAL-4; Task CAL-3

---

## Context and Problem Statement

When generating desk calendar review videos via the approved provider (Muse4AI/Muse), only the front cover is uploaded as reference. The provider model generates a video of a reviewer presenting the calendar and turning to a blank cream interior page. To prevent AI models from hallucinating garbled numbers, distorted days, or unauthorized designs, the user's authentic interior artwork must be composited onto the blank interior page locally.

Key architectural requirements:
1. **Zero generative models:** The user's artwork must be placed with strict geometric perspective fidelity without AI modification.
2. **Platform & Process Stability:** Do not lock the Node/Electron main event loop or introduce unstable native Node addons (`node-gyp`).
3. **Security:** No network access, no exposure of absolute paths to renderer or logs, and execution isolation.
4. **Deterministic Quality Gate:** Misaligned or poorly tracked videos must fail safely rather than exporting flawed output.

---

## Decision

### 1. Bundled Sidecar Executable Architecture
We implement the compositor as a **bundled standalone sidecar executable** built with Python 3.13, OpenCV (`opencv-python-headless`), and NumPy, frozen with PyInstaller (`--onedir`), bundled alongside `ffmpeg.exe` and `ffprobe.exe`.
- **Spawn mechanism:** Invoked strictly via `child_process.spawn(executable, args, { shell: false, windowsHide: true })`.
- **No Node native addons:** No C++ native bindings in Node, eliminating ABI mismatch issues across Electron versions.
- **No cloud network calls:** The sidecar performs all processing entirely on local hardware.

### 2. Packaging & ExtraResources Configuration
The sidecar and its companion binaries are built into `vendor/calendar-compositor/dist/calendar-compositor/` (gitignored).

The lead must add the following entry to `electron-builder.yml` under `extraResources`:
```yaml
extraResources:
  - from: vendor/calendar-compositor/dist
    to: calendar-compositor
    filter:
      - '**/*'
```
When packaged, the application directory layout will resolve:
```text
<resourcesDir>/
  calendar-compositor/
    calendar-compositor.exe
    ffmpeg.exe
    ffprobe.exe
    _internal/ (Python/OpenCV runtime dlls and libraries)
```

### 3. Pipeline & Algorithmic Strategy
1. **Probe:** `ffprobe` extracts exact framerate, dimensions, duration, and audio stream existence.
2. **Detection:** Combined color/brightness thresholding (cream/light paper mask in HSV/LAB) and convex polygon approximation detect candidate page quadrilaterals.
3. **Tracking & Optical Flow:** Lucas-Kanade optical flow (`calcOpticalFlowPyrLK`) on an interior grid + RANSAC homography estimation track corner positions across frames. Drift is corrected by periodic fusion with confident page detections.
4. **Warping & Margin Inset:** Full-resolution artwork is warped in-memory onto the quadrilateral with a 1.5% margin inset to prevent bleed over spirals and page borders. Mask edges are feathered `<= 2 px`.
5. **Hand/Finger Preservation:** Skin-color segmentation in YCrCb/HSV detects fingers or thumbs entering the page quad and preserves hand pixels on top of the artwork.
6. **Temporal Smoothing & Low Confidence Protection:** Confident frame runs use an exponential moving average (alpha=0.3) to eliminate sub-pixel jitter. Low confidence frames (`< 0.65`) suppress artwork rendering to eliminate jumping or drifting.
7. **Audio Preservation:** Audio stream from the input video is preserved bit-for-bit via ffmpeg stream copy (`-c:a copy`).

### 4. Quality Gate & Safe Failure
If any of the following conditions occur:
- Open-page visible duration is `< 1.5 s` (`visibleFrames < 1.4 * fps`).
- Tracking coverage is `< --min-coverage` (default `0.6`).
- Average page area is `< 5%` of the video frame.

The sidecar:
- Exits with **code 3**.
- **Deletes any partial output video** (no corrupt or misaligned video is retained).
- Writes a report JSON with `applied: false`.
- The TypeScript adapter maps exit code 3 to `PodError('CALENDAR_COMPOSITING_FAILED')` with employee-safe messaging.

### 5. Process Lifecycle & Security Controls
- **Path Traversal Protection:** The TypeScript adapter verifies that `calendar-compositor.exe`, `ffmpeg.exe`, and `ffprobe.exe` strictly resolve within `<resourcesDir>/calendar-compositor/`. Execution of executables outside that boundary is refused.
- **Path Confinement:** Input and output video paths must reside within the application private `tempDir`.
- **Process Management & Timeout:** Sidecar invocations are subject to a configurable timeout (default 10 minutes). Live child processes are tracked; on app shutdown or cancellation, the process tree is cleanly terminated.
- **Log Privacy:** No absolute paths, prompt text, or image byte buffers are emitted to logs, stderr, or reports.

### 6. FFmpeg Build & Licensing Notice
The local build at `C:\ffmpeg\bin` was compiled with `--enable-gpl --enable-version3`, placing that specific binary under GPL v3.0. For commercial production installers, the lead should ensure the release packaging pipeline uses an **LGPL build** of FFmpeg.

---

## Consequences

### Positive
- High-fidelity artwork placement without risking generative AI hallucinations.
- Completely isolated process crashes cannot terminate the main Electron UI or backend orchestrator.
- Deterministic quality gate protects brand and product standards by rejecting poorly tracked generations.
- Preserves 100% of the apparel generation pipeline without alterations.

### Negative / Trade-offs
- Installer size increases due to the bundled Python runtime and FFmpeg binaries (~120 MB).
- Severe perspective tilt or curved pages during fast flips cannot be mapped with simple 2D homography (handled safely by skipping artwork rendering on low-confidence frames).
