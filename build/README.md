# Installer Branding Resources

## Application Icon (`icon.ico`)
- **Format:** Windows Icon (`.ico`) containing multiple resolutions: 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256.
- **Color Depth:** 32-bit (24-bit RGB + 8-bit alpha channel).
- **Placement:** Place company-approved `icon.ico` in this directory (`build/icon.ico`).
- **Placeholder Note:** Currently using Electron / Windows default icon until company design assets are formally signed off.

## Custom NSIS Installer Script (`installer.nsh`)
- `installer.nsh` in this folder provides optional hooks for the NSIS installer (e.g. custom install steps, file associations, or environment checks).
