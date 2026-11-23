// PHASE 0 SKELETON — owned by W6 (orchestrator/IPC wiring). Replaced during wave 2.
import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'POD Video Studio',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Never open arbitrary windows / navigate away from the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void shell; // reserved for library:openFolder (shell.showItemInFolder), never shell.openPath on media

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
