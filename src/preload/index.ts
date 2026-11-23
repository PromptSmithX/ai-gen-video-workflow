import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PodApi } from '../shared/ipc';
import { IPC } from '../shared/ipc-channels';

const api: PodApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
  },
  provider: {
    getStatus: () => ipcRenderer.invoke(IPC.providerGetStatus),
    testConnection: () => ipcRenderer.invoke(IPC.providerTestConnection),
  },
  images: {
    pick: () => ipcRenderer.invoke(IPC.imagesPick),
    stageFile: (file: File) => {
      const filePath = webUtils.getPathForFile(file);
      return ipcRenderer.invoke(IPC.imagesStagePath, { path: filePath });
    },
  },
  catalog: {
    listCategories: () => ipcRenderer.invoke(IPC.catalogListCategories),
  },
  prompts: {
    listTemplates: () => ipcRenderer.invoke(IPC.promptsListTemplates),
    getTemplate: (input) => ipcRenderer.invoke(IPC.promptsGetTemplate, input),
    preview: (input) => ipcRenderer.invoke(IPC.promptsPreview, input),
    validate: (input) => ipcRenderer.invoke(IPC.promptsValidate, input),
    saveVersion: (input) => ipcRenderer.invoke(IPC.promptsSaveVersion, input),
    setDefault: (input) => ipcRenderer.invoke(IPC.promptsSetDefault, input),
  },
  jobs: {
    create: (input) => ipcRenderer.invoke(IPC.jobsCreate, input),
    list: (input) => ipcRenderer.invoke(IPC.jobsList, input),
    get: (input) => ipcRenderer.invoke(IPC.jobsGet, input),
    retry: (input) => ipcRenderer.invoke(IPC.jobsRetry, input),
    regenerate: (input) => ipcRenderer.invoke(IPC.jobsRegenerate, input),
    resolveAmbiguous: (input) => ipcRenderer.invoke(IPC.jobsResolveAmbiguous, input),
    retryDownload: (input) => ipcRenderer.invoke(IPC.jobsRetryDownload, input),
    cancel: (input) => ipcRenderer.invoke(IPC.jobsCancel, input),
    setReview: (input) => ipcRenderer.invoke(IPC.jobsSetReview, input),
    onUpdated: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, view: unknown) => {
        listener(view as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.jobsUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC.jobsUpdated, handler);
      };
    },
  },
  library: {
    openFolder: (input) => ipcRenderer.invoke(IPC.libraryOpenFolder, input),
    copyPath: (input) => ipcRenderer.invoke(IPC.libraryCopyPath, input),
  },
  admin: {
    getSettings: () => ipcRenderer.invoke(IPC.adminGetSettings),
    updateSettings: (input) => ipcRenderer.invoke(IPC.adminUpdateSettings, input),
    setBridgeApiKey: (input) => ipcRenderer.invoke(IPC.adminSetBridgeApiKey, input),
    clearBridgeApiKey: () => ipcRenderer.invoke(IPC.adminClearBridgeApiKey),
    diagnosticsPreview: () => ipcRenderer.invoke(IPC.adminDiagnosticsPreview),
    diagnosticsExport: () => ipcRenderer.invoke(IPC.adminDiagnosticsExport),
    runCleanup: () => ipcRenderer.invoke(IPC.adminRunCleanup),
  },
};

contextBridge.exposeInMainWorld('api', api satisfies PodApi);
