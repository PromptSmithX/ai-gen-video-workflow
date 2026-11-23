; POD Video Studio - NSIS Installer Customizations
; Provides hooks for per-user installation without requiring administrative elevation.

!macro customInit
  ; Ensure installation runs as standard user
!macroend

!macro customInstall
  ; Preserve user data and media library directories during installation/updates
!macroend

!macro customUnInstall
  ; Respect deleteAppDataOnUninstall: false (keep library and SQLite database on uninstall)
!macroend
