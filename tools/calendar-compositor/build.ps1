# tools/calendar-compositor/build.ps1
# Builds the calendar-compositor sidecar into vendor/calendar-compositor/dist/
[CmdletBinding()]
param (
    [string]$FfmpegBin = "C:\ffmpeg\bin",
    [switch]$SkipVenv = $false
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path "$ScriptDir\..\.."
$VenvDir = "$ScriptDir\.venv"
$RequirementsFile = "$ScriptDir\requirements.txt"
$VendorDir = "$RepoRoot\vendor\calendar-compositor"
$DistDir = "$VendorDir\dist"
$BuildDir = "$VendorDir\build"
$TargetDir = "$DistDir\calendar-compositor"

Write-Host "=== Calendar Compositor Build ===" -ForegroundColor Cyan
Write-Host "Script Dir: $ScriptDir"
Write-Host "Repo Root:  $RepoRoot"
Write-Host "Dist Dir:   $DistDir"

# 1. Setup / refresh venv
if (-not $SkipVenv) {
    if (-not (Test-Path "$VenvDir\Scripts\python.exe")) {
        Write-Host "Creating Python virtual environment in $VenvDir..."
        python -m venv $VenvDir
    }
    Write-Host "Installing pinned dependencies from $RequirementsFile..."
    & "$VenvDir\Scripts\python.exe" -m pip install --upgrade pip
    & "$VenvDir\Scripts\python.exe" -m pip install -r $RequirementsFile
}

$PyInstallerExe = "$VenvDir\Scripts\pyinstaller.exe"
if (-not (Test-Path $PyInstallerExe)) {
    throw "PyInstaller executable not found at $PyInstallerExe"
}

# 2. Clean previous build artifacts
if (Test-Path $BuildDir) {
    Remove-Item -Recurse -Force $BuildDir
}
if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
}
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

# 3. Build sidecar executable with PyInstaller (--onedir)
Write-Host "Freezing calendar-compositor with PyInstaller..." -ForegroundColor Yellow
$EntryScript = "$ScriptDir\calendar_compositor.py"
& $PyInstallerExe --onedir `
    --clean `
    --noconfirm `
    --name calendar-compositor `
    --distpath $DistDir `
    --workpath $BuildDir `
    --specpath "$ScriptDir" `
    $EntryScript

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed with exit code $LASTEXITCODE"
}

# 4. Copy ffmpeg.exe and ffprobe.exe into the bundled folder
Write-Host "Copying ffmpeg and ffprobe from $FfmpegBin..." -ForegroundColor Yellow
$FfmpegSrc = "$FfmpegBin\ffmpeg.exe"
$FfprobeSrc = "$FfmpegBin\ffprobe.exe"

if (-not (Test-Path $FfmpegSrc) -or -not (Test-Path $FfprobeSrc)) {
    throw "ffmpeg.exe or ffprobe.exe not found in $FfmpegBin"
}

Copy-Item -Force $FfmpegSrc "$TargetDir\ffmpeg.exe"
Copy-Item -Force $FfprobeSrc "$TargetDir\ffprobe.exe"

# 5. Verify build outputs
$ExePath = "$TargetDir\calendar-compositor.exe"
if (-not (Test-Path $ExePath)) {
    throw "Built executable not found at $ExePath"
}

Write-Host "Verifying bundled executable..." -ForegroundColor Green
& $ExePath --help | Out-Null
Write-Host "=== Build Succeeded! Bundled sidecar ready at: $TargetDir ===" -ForegroundColor Green
