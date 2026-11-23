import path from 'node:path';
import { clipboard, dialog, ipcMain, shell } from 'electron';
import { PodError } from '@shared/errors';
import type { JobState } from '@shared/job-state';
import {
  CreateJobInput,
  GetTemplateInput,
  IPC,
  JobIdInput,
  JobListInput,
  PromptPreviewInput,
  RegenerateJobInput,
  ResolveAmbiguousInput,
  RetryJobInput,
  SaveTemplateVersionInput,
  SetApiKeyInput,
  SetDefaultTemplateInput,
  SetReviewInput,
  StagePathInput,
  UpdateSettingsInput,
  ValidatePromptInput,
} from '@shared/ipc';
import type { AppContainer } from '../app/container';
import { nowIso } from '../domain/ids';
import { exportDiagnosticsToFile } from '../infra/diagnostics';
import { cleanupLogs } from '../infra/logging';
import { cleanupTemp } from '../infra/media';
import { registerIpcHandler } from './handler';

export function registerAllIpcHandlers(container: AppContainer): void {
  const { logger, isPackaged } = container;
  const isDev = !isPackaged;
  const isAdmin = (): boolean => container.isAdmin();

  // 1. App Info
  registerIpcHandler(ipcMain, {
    channel: IPC.appGetInfo,
    logger,
    isDev,
    handler: () => ({
      version: container.appVersion,
      employeeId: container.employeeId,
      isAdmin: container.isAdmin(),
      providerMode: container.config.providerMode,
      isDev: container.config.isDev,
    }),
  });

  // 2. Provider Status
  registerIpcHandler(ipcMain, {
    channel: IPC.providerGetStatus,
    logger,
    isDev,
    handler: () => container.getProviderStatus(),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.providerTestConnection,
    logger,
    isDev,
    handler: () => container.getProviderStatus(),
  });

  // 3. Images: Pick & Stage
  registerIpcHandler(ipcMain, {
    channel: IPC.imagesPick,
    logger,
    isDev,
    handler: async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const selectedPath = result.filePaths[0];
      if (!selectedPath) return null;
      const info = await container.media.validateImage(selectedPath);
      return container.imageStaging.stage(selectedPath, info);
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.imagesStagePath,
    schema: StagePathInput,
    logger,
    isDev,
    handler: async (input) => {
      const info = await container.media.validateImage(input.path);
      return container.imageStaging.stage(input.path, info);
    },
  });

  // 4. Catalog Categories
  registerIpcHandler(ipcMain, {
    channel: IPC.catalogListCategories,
    logger,
    isDev,
    handler: () => container.config.categories,
  });

  // 5. Prompts
  registerIpcHandler(ipcMain, {
    channel: IPC.promptsListTemplates,
    logger,
    isDev,
    handler: () => container.prompts.listTemplates(),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.promptsGetTemplate,
    schema: GetTemplateInput,
    logger,
    isDev,
    handler: (input) => container.prompts.getTemplate(input.id, input.version),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.promptsPreview,
    schema: PromptPreviewInput,
    logger,
    isDev,
    handler: async (input) => {
      const category = container.config.categories.find((c) => c.id === input.categoryId);
      if (!category) {
        throw new PodError('CONFIG_INVALID', 'Category not found');
      }
      const caps = await container.orchestrator.getCapabilities();
      return container.prompts.render({
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        variables: {
          sku: input.sku,
          product_category: category.label,
          product_name: input.productName,
          source_image_filename: input.fileName,
          duration_seconds: input.durationSeconds,
          aspect_ratio: input.aspectRatio,
          review_style: input.reviewStyle,
        },
        categoryGroup: category.promptGroup,
        maxChars: container.config.promptMaxChars,
        supportsDuration: caps.supportedDurations.length > 0,
        supportsAspectRatio: caps.supportedAspectRatios.length > 0,
      });
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.promptsValidate,
    schema: ValidatePromptInput,
    logger,
    isDev,
    handler: (input) => {
      const validated = container.prompts.validatePrompt(input.text, container.config.promptMaxChars);
      return {
        text: input.text,
        chars: input.text.length,
        maxChars: container.config.promptMaxChars,
        templateId: '',
        templateVersion: '',
        isPlaceholder: false,
        quality: validated.quality,
        errors: validated.errors,
      };
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.promptsSaveVersion,
    schema: SaveTemplateVersionInput,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: (input) => container.prompts.saveTemplateVersion(input),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.promptsSetDefault,
    schema: SetDefaultTemplateInput,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: (input) => {
      container.prompts.setDefault(input.id, input.version);
    },
  });

  // 6. Jobs
  registerIpcHandler(ipcMain, {
    channel: IPC.jobsCreate,
    schema: CreateJobInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.createJob(input, container.employeeId),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsList,
    schema: JobListInput.optional(),
    logger,
    isDev,
    handler: (input) =>
      container.orchestrator.listJobs(
        input
          ? {
              ...input,
              category: input.categoryId,
              states: input.states as JobState[] | undefined,
            }
          : undefined
      ),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsGet,
    schema: JobIdInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.getJob(input.jobId),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsRetry,
    schema: RetryJobInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.retry(input.jobId, input.acknowledged),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsRegenerate,
    schema: RegenerateJobInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.regenerate(input.jobId, input.confirmed, input.clientRequestId),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsResolveAmbiguous,
    schema: ResolveAmbiguousInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.resolveAmbiguous(input.jobId, input.resolution),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsRetryDownload,
    schema: JobIdInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.retryDownload(input.jobId),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsCancel,
    schema: JobIdInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.cancel(input.jobId),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.jobsSetReview,
    schema: SetReviewInput,
    logger,
    isDev,
    handler: (input) => container.orchestrator.setReview(input.jobId, input.status),
  });

  // 7. Library: openFolder & copyPath
  registerIpcHandler(ipcMain, {
    channel: IPC.libraryOpenFolder,
    schema: JobIdInput,
    logger,
    isDev,
    handler: (input) => {
      const job = container.db.jobs.getById(input.jobId);
      if (!job) throw new PodError('NOT_FOUND', 'Job not found');
      const assets = container.db.assets.listByJob(job.id);
      const videoAsset = assets.find((a) => a.role === 'generated_video');
      const targetAsset = videoAsset ?? container.db.assets.getById(job.sourceAssetId);
      if (!targetAsset) throw new PodError('NOT_FOUND', 'Asset not found');
      const absPath = container.media.resolve(targetAsset.path);
      shell.showItemInFolder(absPath);
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.libraryCopyPath,
    schema: JobIdInput,
    logger,
    isDev,
    handler: (input) => {
      const job = container.db.jobs.getById(input.jobId);
      if (!job) throw new PodError('NOT_FOUND', 'Job not found');
      const assets = container.db.assets.listByJob(job.id);
      const videoAsset = assets.find((a) => a.role === 'generated_video');
      const targetAsset = videoAsset ?? container.db.assets.getById(job.sourceAssetId);
      if (!targetAsset) throw new PodError('NOT_FOUND', 'Asset not found');
      const absPath = container.media.resolve(targetAsset.path);
      clipboard.writeText(absPath);
    },
  });

  // 8. Admin operations
  registerIpcHandler(ipcMain, {
    channel: IPC.adminGetSettings,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: () => container.getEffectiveAdminSettings(),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.adminUpdateSettings,
    schema: UpdateSettingsInput,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: (input) => container.updateSettings(input),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.adminSetBridgeApiKey,
    schema: SetApiKeyInput,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: (input) => {
      container.secretStore.set('bridge_api_key', input.apiKey);
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.adminClearBridgeApiKey,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: () => {
      container.secretStore.delete('bridge_api_key');
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.adminDiagnosticsPreview,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: () => container.getDiagnosticsPreview(),
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.adminDiagnosticsExport,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: async () => {
      const preview = await container.getDiagnosticsPreview();
      const saveRes = await dialog.showSaveDialog({
        defaultPath: `pod-diagnostics-${nowIso().slice(0, 10)}.txt`,
        filters: [{ name: 'Text Files', extensions: ['txt'] }],
      });
      if (saveRes.canceled || !saveRes.filePath) {
        return { saved: false };
      }
      exportDiagnosticsToFile(saveRes.filePath, preview.content);
      return { saved: true };
    },
  });

  registerIpcHandler(ipcMain, {
    channel: IPC.adminRunCleanup,
    adminOnly: true,
    isAdmin,
    logger,
    isDev,
    handler: () => {
      const logsDir = path.join(container.userData, 'logs');
      const tempDir = path.join(container.config.libraryRoot, '.tmp');
      const removedLogFiles = cleanupLogs(logsDir, container.config.logRetentionDays);
      const removedTempFiles = cleanupTemp(tempDir, 24 * 60 * 60 * 1000);
      return { removedLogFiles, removedTempFiles };
    },
  });
}
