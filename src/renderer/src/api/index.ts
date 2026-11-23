import type { PodApi } from '@shared/ipc';

let apiOverride: PodApi | null = null;
let devFakeApiPromise: Promise<PodApi> | null = null;

async function getDevFakeApi(): Promise<PodApi> {
  if (import.meta.env.PROD) {
    throw new Error('Application backend is unavailable');
  }
  if (!devFakeApiPromise) {
    devFakeApiPromise = import('./fake-api').then((m) => m.fakeApi);
  }
  return devFakeApiPromise;
}

const devProxy: PodApi = {
  app: {
    getInfo: async () => (await getDevFakeApi()).app.getInfo(),
  },
  provider: {
    getStatus: async () => (await getDevFakeApi()).provider.getStatus(),
    testConnection: async () => (await getDevFakeApi()).provider.testConnection(),
  },
  images: {
    pick: async () => (await getDevFakeApi()).images.pick(),
    stageFile: async (file) => (await getDevFakeApi()).images.stageFile(file),
  },
  catalog: {
    listCategories: async () => (await getDevFakeApi()).catalog.listCategories(),
  },
  prompts: {
    listTemplates: async () => (await getDevFakeApi()).prompts.listTemplates(),
    getTemplate: async (input) => (await getDevFakeApi()).prompts.getTemplate(input),
    preview: async (input) => (await getDevFakeApi()).prompts.preview(input),
    validate: async (input) => (await getDevFakeApi()).prompts.validate(input),
    saveVersion: async (input) => (await getDevFakeApi()).prompts.saveVersion(input),
    setDefault: async (input) => (await getDevFakeApi()).prompts.setDefault(input),
  },
  jobs: {
    create: async (input) => (await getDevFakeApi()).jobs.create(input),
    list: async (input) => (await getDevFakeApi()).jobs.list(input),
    get: async (input) => (await getDevFakeApi()).jobs.get(input),
    retry: async (input) => (await getDevFakeApi()).jobs.retry(input),
    regenerate: async (input) => (await getDevFakeApi()).jobs.regenerate(input),
    resolveAmbiguous: async (input) => (await getDevFakeApi()).jobs.resolveAmbiguous(input),
    retryDownload: async (input) => (await getDevFakeApi()).jobs.retryDownload(input),
    cancel: async (input) => (await getDevFakeApi()).jobs.cancel(input),
    setReview: async (input) => (await getDevFakeApi()).jobs.setReview(input),
    onUpdated: (listener) => {
      let unsub = () => {};
      getDevFakeApi().then((api) => {
        unsub = api.jobs.onUpdated(listener);
      });
      return () => unsub();
    },
  },
  library: {
    openFolder: async (input) => (await getDevFakeApi()).library.openFolder(input),
    copyPath: async (input) => (await getDevFakeApi()).library.copyPath(input),
  },
  admin: {
    getSettings: async () => (await getDevFakeApi()).admin.getSettings(),
    updateSettings: async (input) => (await getDevFakeApi()).admin.updateSettings(input),
    setBridgeApiKey: async (input) => (await getDevFakeApi()).admin.setBridgeApiKey(input),
    clearBridgeApiKey: async () => (await getDevFakeApi()).admin.clearBridgeApiKey(),
    diagnosticsPreview: async () => (await getDevFakeApi()).admin.diagnosticsPreview(),
    diagnosticsExport: async () => (await getDevFakeApi()).admin.diagnosticsExport(),
    runCleanup: async () => (await getDevFakeApi()).admin.runCleanup(),
  },
};

/** For testing or mocking */
export function setApiOverride(api: PodApi | null): void {
  apiOverride = api;
}

export function isBackendUnavailable(): boolean {
  if (apiOverride) return false;
  if (typeof window !== 'undefined' && window.api && Object.keys(window.api).length > 0) {
    return false;
  }
  return Boolean(import.meta.env.PROD);
}

export function isFakeApi(): boolean {
  if (apiOverride) return false;
  if (import.meta.env.PROD) return false;
  if (typeof window !== 'undefined' && window.api && Object.keys(window.api).length > 0) {
    return false;
  }
  return true;
}

export function getApi(): PodApi {
  if (apiOverride) {
    return apiOverride;
  }
  if (typeof window !== 'undefined' && window.api && Object.keys(window.api).length > 0) {
    return window.api;
  }
  if (import.meta.env.PROD) {
    throw new Error('Application backend is unavailable');
  }
  return devProxy;
}
