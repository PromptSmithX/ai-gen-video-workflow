# Software Bill of Materials (SBOM): Calendar Artwork Compositor

- **Component:** Calendar Artwork Compositor Sidecar
- **Path:** `vendor/calendar-compositor/dist/calendar-compositor/`
- **Architecture:** x86_64 Windows standalone binary sidecar + bundled FFmpeg tools
- **Spawn Model:** Process isolation via `child_process.spawn(exe, args, { shell: false })`

---

## 1. Direct Components & Binaries

| Component | Version | Source / Upstream | License | License Type | Commercial Suitability / Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Python Runtime** | 3.13.12 | [python.org](https://www.python.org/) / Miniconda | PSF License (Python Software Foundation License 2.0) | Permissive | Fully permitted for commercial bundling. |
| **OpenCV (`opencv-python-headless`)** | 5.0.0.93 | [pypi.org/project/opencv-python-headless](https://pypi.org/project/opencv-python-headless/) | Apache 2.0 | Permissive | Free for commercial use; no patent claims; headless avoids desktop GUI dependencies. |
| **NumPy** | 2.4.6 | [pypi.org/project/numpy](https://pypi.org/project/numpy/) | BSD 3-Clause | Permissive | Standard scientific numerical library; fully permitted. |
| **PyInstaller** | 6.22.3 | [pypi.org/project/pyinstaller](https://pypi.org/project/pyinstaller/) | GPL v2 with Special Exception | Permissive exception for outputs | PyInstaller exception explicitly permits commercial distribution of frozen applications without requiring application source code disclosure. |
| **pytest** (dev/test only) | 8.3.5 | [pypi.org/project/pytest](https://pypi.org/project/pytest/) | MIT | Permissive | Not bundled into the production sidecar. |
| **FFmpeg (`ffmpeg.exe`, `ffprobe.exe`)** | `N-124098-ge717604a29-20260426` | Local Windows build (`C:\ffmpeg\bin`) | **GPL v3.0** (`--enable-gpl --enable-version3`) | **Strong Copyleft** | **FLAGGED FOR LEAD REVIEW** (see §2 below). |

---

## 2. Licensing Compliance & FFmpeg Assessment

### GPL Build Flag for Lead Developer
> [!WARNING]
> **FFmpeg Build License Notice**:
> The build of FFmpeg found on the build system at `C:\ffmpeg\bin` was compiled with `--enable-gpl --enable-version3`.
> As a result, this binary is licensed under **GPL v3.0**, not LGPL.
>
> **Isolation Status**:
> In our architecture, `calendar-compositor.exe`, `ffmpeg.exe`, and `ffprobe.exe` are completely standalone executables executed strictly via separate OS process calls (`spawn` with `shell: false`). The main TypeScript application links no native C/Node libraries.
>
> **Recommendation**:
> To strictly prevent any GPL copyleft contagion concerns for the distributed installer, the release pipeline should replace the FFmpeg binary with an **LGPL v2.1/v3.0 build** (compiled without `--enable-gpl` and without `--enable-nonfree`). The local compositor utilizes only standard H.264 decoding/encoding (`libx264` or native H.264 wrapper) and AAC audio copying, which are fully supported in standard LGPL-compliant distribution pipelines.

---

## 3. Python Transitive Dependencies

| Dependency | Version | License | Note |
| :--- | :--- | :--- | :--- |
| `altgraph` | 0.17.5 | MIT | Graph representation library used by PyInstaller. |
| `pefile` | 2024.8.26 | MIT | Portable Executable parser used by PyInstaller. |
| `pywin32-ctypes` | 0.2.3 | BSD 3-Clause | Windows ctypes bindings. |
| `pyinstaller-hooks-contrib` | 2026.10 | Apache 2.0 | Community PyInstaller hooks. |
| `packaging` | 26.4 | Apache 2.0 / BSD 2-Clause | Package metadata utilities. |
| `setuptools` | 84.2.1 | MIT | Build backend. |
