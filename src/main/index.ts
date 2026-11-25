import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, net, protocol } from 'electron';
import { PodError } from '@shared/errors';
import { IPC, MEDIA_PROTOCOL } from '@shared/ipc';
import { createAppContainer, type AppContainer } from './app/container';
import { registerAllIpcHandlers } from './ipc/register';

// Register custom protocol as privileged before app.whenReady
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let container: AppContainer | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
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

  // Never open arbitrary windows or navigate away from the app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    // 1. Create composition root / container
    try {
      container = createAppContainer({
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        documents: app.getPath('documents'),
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
      });
    } catch (err: unknown) {
      const msg = err instanceof PodError ? err.safeMessage : 'Configuration error';
      dialog.showErrorBox('POD Video Studio', msg);
      app.quit();
      return;
    }

    // 2. Register pod-media protocol
    protocol.handle(MEDIA_PROTOCOL, async (request) => {
      if (!container) {
        return new Response('Not Found', { status: 404 });
      }

      try {
        const url = new URL(request.url);
        const segments = [url.host, ...url.pathname.split('/')].filter(Boolean);
        const kind = segments[0];
        const id = segments[1];

        if (kind === 'asset' && id) {
          const asset = container.db.assets.getById(id);
          if (!asset) {
            return new Response('Not Found', { status: 404 });
          }
          const absPath = container.media.resolve(asset.path);
          if (!fs.existsSync(absPath)) {
            return new Response('Not Found', { status: 404 });
          }
          return net.fetch(pathToFileURL(absPath).toString());
        }

        if (kind === 'staged' && id) {
          const staged = container.imageStaging.get(id);
          if (!staged || !fs.existsSync(staged.absPath)) {
            return new Response('Not Found', { status: 404 });
          }
          return net.fetch(pathToFileURL(staged.absPath).toString());
        }

        return new Response('Not Found', { status: 404 });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    });

    // 3. Restart recovery on startup
    await container.orchestrator.recover();

    // 4. Register IPC handlers
    registerAllIpcHandlers(container);

    // 5. Forward JobView updates to renderer
    container.orchestrator.on('job:updated', (view) => {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.jobsUpdated, view);
        }
      }
    });

    // 6. Create window
    mainWindow = createWindow();

    // 7. Bundled Muse4AI: start + provision in the background (the Setup screen shows progress).
    if (container.muse4ai) void container.muse4ai.ensure();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (container) {
      container.close();
      container = null;
    }
  });
}
