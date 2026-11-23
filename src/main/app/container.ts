import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AdminSettings, AppConfig } from '@shared/config';
import type { DiagnosticsPreview, PlatformCompatibility, ProviderStatus } from '@shared/ipc';
import type { MuseProvider, ProviderCapabilities } from '@shared/provider';
import type { Logger, MediaLibrary, PodDatabase, PromptService, SecretStore } from '@shared/services';
import { nowIso } from '../domain/ids';
import { isAdmin, loadConfig, readEffectiveEnv } from '../infra/config';
import { openDatabase } from '../infra/db';
import { buildDiagnostics } from '../infra/diagnostics';
import { createLogger } from '../infra/logging';
import { createMediaLibrary } from '../infra/media';
import { createPromptService } from '../prompts';
import { createMuseProvider } from '../providers/muse';
import { createSecretStore, getBridgeApiKey, type SafeStorageLike } from '../infra/secrets';
import { ImageStagingService } from './image-staging';
import { JobOrchestrator } from './job-orchestrator';

export interface CreateContainerOpts {
  appPath: string;
  userData: string;
  documents: string;
  isPackaged: boolean;
  appVersion?: string;
  safeStorage?: SafeStorageLike;
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
}

export class AppContainer {
  readonly appVersion: string;
  readonly appPath: string;
  readonly userData: string;
  readonly documents: string;
  readonly isPackaged: boolean;
  readonly employeeId: string;

  effectiveEnv: Record<string, string | undefined>;
  config: AppConfig;
  readonly db: PodDatabase;
  readonly logger: Logger & { flush(): Promise<void> };
  readonly secretStore: SecretStore;
  readonly media: MediaLibrary;
  readonly prompts: PromptService;
  readonly imageStaging: ImageStagingService;
  provider: MuseProvider;
  readonly orchestrator: JobOrchestrator;

  constructor(opts: CreateContainerOpts) {
    this.appVersion = opts.appVersion ?? '0.1.0';
    this.appPath = opts.appPath;
    this.userData = opts.userData;
    this.documents = opts.documents;
    this.isPackaged = opts.isPackaged;

    let username: string;
    try {
      username = os.userInfo().username || 'employee';
    } catch {
      username = 'employee';
    }
    this.employeeId = username;

    // 1. Open Database
    const dbPath = path.join(this.userData, 'pod-studio.db');
    this.db = openDatabase(dbPath);

    // 2. Read stored admin settings from DB
    const adminSettings = this.db.settings.get<Partial<AdminSettings>>('admin_settings') ?? {};

    // 3. Load effective env and config
    const processEnv = opts.env ?? process.env;
    this.effectiveEnv = readEffectiveEnv({
      env: processEnv,
      isDev: !opts.isPackaged,
      userDataDir: this.userData,
      cwd: this.appPath,
      envFilePath: opts.envFilePath,
    });

    this.config = loadConfig({
      env: processEnv,
      settings: adminSettings,
      paths: {
        userData: this.userData,
        documents: this.documents,
      },
      isDev: !opts.isPackaged,
      envFilePath: opts.envFilePath,
    });

    // 4. Logger
    const logsDir = path.join(this.userData, 'logs');
    this.logger = createLogger({
      dir: logsDir,
      retentionDays: this.config.logRetentionDays,
    });

    // 5. Secret Store
    const storageImpl: SafeStorageLike =
      opts.safeStorage ?? (safeStorage as SafeStorageLike);
    const secretsPath = path.join(this.userData, 'secrets.json');
    this.secretStore = createSecretStore({
      safeStorage: storageImpl,
      filePath: secretsPath,
    });

    // 6. Media Library
    const tempDir = path.join(this.config.libraryRoot, '.tmp');
    this.media = createMediaLibrary({
      root: this.config.libraryRoot,
      tempDir,
      maxSourceBytes: this.config.maxSourceBytes,
      maxSourcePixels: this.config.maxSourcePixels,
      maxVideoBytes: this.config.maxVideoBytes,
    });

    // 7. Prompt Service
    const builtinDir = this.isPackaged
      ? path.join((process as unknown as { resourcesPath?: string }).resourcesPath ?? this.appPath, 'prompts')
      : path.join(this.appPath, 'prompts');
    const adminPromptsDir = path.join(this.userData, 'prompts');

    this.prompts = createPromptService({
      builtinDir,
      adminDir: adminPromptsDir,
      companyMasterPath: this.config.promptMasterPath,
    });

    // 8. Muse Provider
    this.provider = createMuseProvider({
      config: this.config,
      getApiKey: () => this.getApiKey(),
      logger: this.logger,
    });

    // 9. Image Staging
    this.imageStaging = new ImageStagingService();

    // 10. Job Orchestrator
    this.orchestrator = new JobOrchestrator({
      db: this.db,
      media: this.media,
      prompts: this.prompts,
      provider: this.provider,
      config: this.config,
      logger: this.logger,
      imageStaging: this.imageStaging,
    });
  }

  getApiKey(): string | null {
    return getBridgeApiKey(this.secretStore, this.effectiveEnv, this.config.isDev);
  }

  isAdmin(): boolean {
    return isAdmin(this.config, this.employeeId);
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    const state = await this.provider.getConnectionState();
    let capabilities: ProviderCapabilities | null;
    try {
      capabilities = await this.provider.getCapabilities();
    } catch {
      capabilities = null;
    }

    let compatibility: PlatformCompatibility = 'unverified';
    if (this.config.providerMode === 'mock') {
      compatibility = 'compatible';
    } else if (this.config.musePlatformOrigin === 'https://muse.ai') {
      compatibility = 'compatible';
    } else if (this.config.musePlatformOrigin) {
      compatibility = 'not_compatible';
    }

    return {
      mode: this.config.providerMode,
      state,
      capabilities,
      platformOrigin: this.config.musePlatformOrigin,
      bridgeBaseUrl: this.config.bridgeBaseUrl,
      compatibility,
      hasApiKey: Boolean(this.getApiKey()),
      secretStoreAvailable: this.secretStore.isAvailable(),
      checkedAt: nowIso(),
    };
  }

  getEffectiveAdminSettings(): AdminSettings {
    const stored = this.db.settings.get<Partial<AdminSettings>>('admin_settings') ?? {};
    return {
      bridgeBaseUrl: stored.bridgeBaseUrl !== undefined ? stored.bridgeBaseUrl : this.config.bridgeBaseUrl,
      musePlatformOrigin: stored.musePlatformOrigin !== undefined ? stored.musePlatformOrigin : this.config.musePlatformOrigin,
      libraryRoot: stored.libraryRoot ?? this.config.libraryRoot,
      logRetentionDays: stored.logRetentionDays ?? this.config.logRetentionDays,
      categories: stored.categories ?? this.config.categories,
      adminUsers: stored.adminUsers ?? this.config.adminUsers,
      defaultTemplateId: stored.defaultTemplateId ?? null,
      defaultTemplateVersion: stored.defaultTemplateVersion ?? null,
    };
  }

  async updateSettings(input: Partial<AdminSettings>): Promise<AdminSettings> {
    const current = this.db.settings.get<Partial<AdminSettings>>('admin_settings') ?? {};
    const updated: AdminSettings = {
      bridgeBaseUrl: input.bridgeBaseUrl !== undefined ? input.bridgeBaseUrl : current.bridgeBaseUrl ?? this.config.bridgeBaseUrl,
      musePlatformOrigin: input.musePlatformOrigin !== undefined ? input.musePlatformOrigin : current.musePlatformOrigin ?? this.config.musePlatformOrigin,
      libraryRoot: input.libraryRoot ?? current.libraryRoot ?? this.config.libraryRoot,
      logRetentionDays: input.logRetentionDays ?? current.logRetentionDays ?? this.config.logRetentionDays,
      categories: input.categories ?? current.categories ?? this.config.categories,
      adminUsers: input.adminUsers ?? current.adminUsers ?? this.config.adminUsers,
      defaultTemplateId: input.defaultTemplateId !== undefined ? input.defaultTemplateId : current.defaultTemplateId ?? null,
      defaultTemplateVersion: input.defaultTemplateVersion !== undefined ? input.defaultTemplateVersion : current.defaultTemplateVersion ?? null,
    };

    this.db.settings.set('admin_settings', updated);

    // Reload config
    this.config = loadConfig({
      env: process.env,
      settings: updated,
      paths: {
        userData: this.userData,
        documents: this.documents,
      },
      isDev: !this.isPackaged,
    });

    // Recreate provider
    this.provider = createMuseProvider({
      config: this.config,
      getApiKey: () => this.getApiKey(),
      logger: this.logger,
    });

    this.orchestrator.setProvider(this.provider);
    this.orchestrator.setConfig(this.config);

    if (updated.defaultTemplateId && updated.defaultTemplateVersion) {
      try {
        this.prompts.setDefault(updated.defaultTemplateId, updated.defaultTemplateVersion);
      } catch {
        // ignore if template not found
      }
    }

    return updated;
  }

  async getDiagnosticsPreview(): Promise<DiagnosticsPreview> {
    const providerStatus = await this.getProviderStatus();
    const allJobs = this.db.jobs.list();
    const jobCounts: Record<string, number> = {};
    for (const j of allJobs) {
      jobCounts[j.state] = (jobCounts[j.state] || 0) + 1;
    }

    // Read recent log lines from today's log file
    const todayStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(this.userData, 'logs', `pod-${todayStr}.log`);
    let recentLogLines: string[] = [];
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf-8');
        recentLogLines = content.split('\n').filter(Boolean).slice(-200);
      } catch {
        recentLogLines = [];
      }
    }

    const content = buildDiagnostics({
      appVersion: this.appVersion,
      config: this.config,
      providerStatus,
      recentLogLines,
      jobCounts,
      hasApiKey: Boolean(this.getApiKey()),
    });

    return {
      content,
      generatedAt: nowIso(),
    };
  }

  close(): void {
    this.orchestrator.stop();
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

export function createAppContainer(opts: CreateContainerOpts): AppContainer {
  return new AppContainer(opts);
}
