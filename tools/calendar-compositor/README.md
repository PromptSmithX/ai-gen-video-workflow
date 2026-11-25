# Calendar Artwork Compositor Sidecar

Local computer vision sidecar executable that tracks the blank cream interior page of a generated desk calendar review video and composites the original user interior artwork onto it with high accuracy.

## Architecture & Pipeline

1. **Probe**: Probe the input video using `ffprobe` to extract resolution, exact framerate, duration, and audio stream layout.
2. **Detection**: Detect the blank light/cream page quadrilateral using combined HSV/LAB brightness/low-texture color masking and convex polygon approximation.
3. **Tracking**: Lucas-Kanade optical flow (`calcOpticalFlowPyrLK`) on an interior grid and feature points + RANSAC homography estimation. Re-detection is fused to prevent temporal drift.
4. **Warping & Masking**: The full-resolution original artwork is warped in-memory onto the smoothed quad with a 1.5% margin inset to keep artwork clear of page edges and top spirals. The mask is feathered <= 2 px.
5. **Hand Handling**: Skin-tone segmentation inside the quad prevents drawing artwork over the reviewer's fingers.
6. **Encoding & Audio**: The composited frames are streamed to `ffmpeg` via raw video pipe, copying the original audio stream bit-for-bit.
7. **Quality Gate**: If the open page is visible for < 1.5 s, tracking coverage is below `--min-coverage` (default 0.6), or page area is too small, the sidecar exits with code 3, deletes any partial video, and reports `applied: false`.

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
