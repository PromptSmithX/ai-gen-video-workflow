/**
 * IPC channel names. Dependency-free on purpose: the sandboxed preload can only require "electron",
 * so it must import this file (never ipc.ts, which pulls in zod).
 */
/** Custom protocol for previews: pod-media://asset/<assetId> and pod-media://staged/<token>. */
export const MEDIA_PROTOCOL = 'pod-media';

export const IPC = {
  appGetInfo: 'app:getInfo',
  providerGetStatus: 'provider:getStatus',
  providerTestConnection: 'provider:testConnection',
  providerSetupAction: 'provider:setupAction',
  imagesPick: 'images:pick',
  imagesStagePath: 'images:stagePath',
  catalogListCategories: 'catalog:listCategories',
  promptsListTemplates: 'prompts:listTemplates',
  promptsGetTemplate: 'prompts:getTemplate',
  promptsPreview: 'prompts:preview',
  promptsValidate: 'prompts:validate',
  promptsSaveVersion: 'prompts:saveVersion',
  promptsSetDefault: 'prompts:setDefault',
  jobsCreate: 'jobs:create',
  jobsList: 'jobs:list',
  jobsGet: 'jobs:get',
  jobsRetry: 'jobs:retry',
  jobsRegenerate: 'jobs:regenerate',
  jobsResolveAmbiguous: 'jobs:resolveAmbiguous',
  jobsRetryDownload: 'jobs:retryDownload',
  jobsCancel: 'jobs:cancel',
  jobsSetReview: 'jobs:setReview',
  libraryOpenFolder: 'library:openFolder',
  libraryCopyPath: 'library:copyPath',
  adminGetSettings: 'admin:getSettings',
  adminUpdateSettings: 'admin:updateSettings',
  adminSetBridgeApiKey: 'admin:setBridgeApiKey',
  adminClearBridgeApiKey: 'admin:clearBridgeApiKey',
  adminDiagnosticsPreview: 'admin:diagnosticsPreview',
  adminDiagnosticsExport: 'admin:diagnosticsExport',
  adminRunCleanup: 'admin:runCleanup',
  /** main -> renderer push event */
  jobsUpdated: 'jobs:updated',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
