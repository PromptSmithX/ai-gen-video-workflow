# Calendar Artwork Compositor Sidecar

Local computer vision sidecar executable that tracks the blank cream interior page of a generated desk calendar review video and composites the original user interior artwork onto it with high accuracy.

## Architecture & Pipeline

1. **Probe**: Probe the input video using `ffprobe` to extract resolution, exact framerate, duration, and audio stream layout.
2. **Detection**: Detect the blank light/cream page quadrilateral using combined HSV/LAB brightness/low-texture color masking and convex polygon approximation.
3. **Tracking**: Lucas-Kanade optical flow (`calcOpticalFlowPyrLK`) on an interior grid and feature points + RANSAC homography estimation. Re-detection is fused to prevent temporal drift.
4. **Warping & Masking**: The full-resolution original artwork is warped in-memory onto the smoothed quad with a 1.5% margin inset to keep artwork clear of page edges and top spirals. The mask is feathered <= 2 px.
5. **Hand Handling**: Skin-tone segmentation inside the quad prevents drawing artwork over the reviewer's fingers.
6. **Encoding & Audio**: The composited frames are streamed to `ffmpeg` via raw video pipe, copying the original audio stream bit-for-bit.
7. **Blank-page check (pass 1)**: every tracked quad must look like the blank page — at least 85% of its interior (hands excluded) bright, near-neutral paper. A printed front cover, the reviewer's clothing or a quad drifted onto the background is rejected and tracking restarts. The tracker also ignores sudden page-size jumps (page merged with a pale wall) unless the new size persists ~0.5 s.
8. **Segment planning**: short detection gaps (≤ 0.25 s) are bridged by interpolating the corners; isolated runs shorter than 0.5 s are dropped so artwork never flashes.
9. **Quality Gate**: the longest continuous open-page run must be ≥ ~1.5 s, at least `--min-coverage` (default 0.6) of the frames between the first and last open-page frame must be tracked, and the page must be large enough. A real review shows the page only for the last seconds, so coverage is measured inside that span, not over the whole clip. On failure the sidecar exits 3 before encoding anything and reports `applied: false`.
10. **Pass 2**: only then are frames composited and encoded (`-f mp4`, so any output file name works, e.g. a `.part` temp file). An encoder failure exits 4.

## CLI Interface

```sh
calendar-compositor --input <input_mp4> \
                    --artwork <artwork_image> \
                    --output <output_mp4> \
                    --ffmpeg <ffmpeg_exe> \
                    --ffprobe <ffprobe_exe> \
                    --report <report_json> \
                    [--min-coverage 0.6]
```

### Exit Codes
- `0`: Success (compositing applied, quality gate passed).
- `2`: Bad input (invalid arguments, missing input files, corrupted image/video).
- `3`: Tracking / Quality gate failed (tracking confidence too low or page visible < 1.5s; partial output deleted).
- `4`: Internal error.

### Report JSON Schema
```json
{
  "applied": true,
  "artworkSha256": "3a87...",
  "processedFrames": 90,
  "visibleFrames": 90,
  "trackingCoverage": 1.0,
  "lowConfidenceFrames": 0,
  "compositorVersion": "1.0.0"
}
```

## Setup & Testing

### 1. Create Virtual Environment and Install Dependencies
```powershell
python -m venv tools/calendar-compositor/.venv
tools/calendar-compositor/.venv/Scripts/python.exe -m pip install -r tools/calendar-compositor/requirements.txt
```

### 2. Generate Synthetic Fixtures
```powershell
tools/calendar-compositor/.venv/Scripts/python.exe tools/calendar-compositor/fixtures/make_fixtures.py --ffmpeg C:\ffmpeg\bin\ffmpeg.exe
```

### 3. Run Python Test Suite
```powershell
tools/calendar-compositor/.venv/Scripts/pytest -v tools/calendar-compositor/tests/test_compositor.py
```

### 4. Build Bundled Executable
```powershell
powershell -ExecutionPolicy Bypass -File tools/calendar-compositor/build.ps1 -FfmpegBin C:\ffmpeg\bin
```
Output directory: `vendor/calendar-compositor/dist/calendar-compositor/`
Contains:
- `calendar-compositor.exe`
- `ffmpeg.exe`
- `ffprobe.exe`
- Python runtime dependencies
