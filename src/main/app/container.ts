import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AdminSettings, AppConfig, BundledResources } from '@shared/config';
import type { DiagnosticsPreview, PlatformCompatibility, ProviderStatus } from '@shared/ipc';
import type { MuseProvider, ProviderCapabilities } from '@shared/provider';
import type { Logger, MediaLibrary, PodDatabase, PromptService, SecretStore, CalendarArtworkCompositor } from '@shared/services';
import { nowIso } from '../domain/ids';
import { isAdmin, loadConfig, readEffectiveEnv } from '../infra/config';
import { openDatabase } from '../infra/db';
import { buildDiagnostics } from '../infra/diagnostics';
import { createLogger } from '../infra/logging';
import { createMediaLibrary } from '../infra/media';
import { createElectronBoardRenderer, createElectronImageEncoder } from '../infra/media/electron-image-encoder';
import { createCalendarCompositor } from '../infra/compositor';
import { createPromptService } from '../prompts';
import { createMuseProvider } from '../providers/muse';
import { createSecretStore, getBridgeApiKey, type SafeStorageLike } from '../infra/secrets';
import { Muse4aiSupervisor } from '../infra/muse4ai/supervisor';
import { ImageStagingService } from './image-staging';
import { JobOrchestrator } from './job-orchestrator';
import { createUnavailableCompositor } from './unavailable-compositor';

export interface CreateContainerOpts {
  appPath: string;
  userData: string;
  documents: string;
  isPackaged: boolean;
  appVersion?: string;
  safeStorage?: SafeStorageLike;
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  /** Override bundled-resource discovery (tests). */
  bundle?: BundledResources;
  /** Override compositor (tests or custom factory). */
  compositor?: CalendarArtworkCompositor & { dispose?(): void };
}

/** Installer-shipped Muse4AI + company Prompt Master (dev: vendor/muse4ai/dist when it was built). */
export function findBundledResources(appPath: string, isPackaged: boolean): BundledResources {
  const resources = isPackaged
    ? ((process as unknown as { resourcesPath?: string }).resourcesPath ?? appPath)
    : appPath;
  const exe = isPackaged
    ? path.join(resources, 'muse4ai', 'Muse4AI.exe')
    : path.join(appPath, 'vendor', 'muse4ai', 'dist', 'Muse4AI.exe');
  const master = path.join(resources, 'prompts', 'company', 'tshirt-review-v2.md');
  return {
    muse4aiExePath: process.platform === 'win32' && fs.existsSync(exe) ? exe : null,
    promptMasterPath: isPackaged && fs.existsSync(master) ? master : null,
  };
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
  readonly compositor: CalendarArtworkCompositor & { dispose?(): void };
  provider: MuseProvider;
  readonly orchestrator: JobOrchestrator;
  /** Present when POD starts and provisions the bundled Muse4AI itself. */
  readonly muse4ai: Muse4aiSupervisor | null;
  private readonly bundle: BundledResources;

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

    this.bundle = opts.bundle ?? findBundledResources(this.appPath, this.isPackaged);
    this.config = loadConfig({
      env: processEnv,
      settings: adminSettings,
      paths: {
        userData: this.userData,
        documents: this.documents,
      },
      isDev: !opts.isPackaged,
      envFilePath: opts.envFilePath,
      bundle: this.bundle,
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

    // 9b. Bundled Muse4AI (only in bridge mode with a loopback bridge URL)
    const exePath = this.config.muse4aiExePath ?? null;
    const bridgeBaseUrl = this.config.bridgeBaseUrl;
    this.muse4ai =
      exePath && bridgeBaseUrl && this.config.providerMode === 'bridge'
        ? new Muse4aiSupervisor({
            exePath,
            bridgeBaseUrl,
            proxyPort: this.config.muse4aiProxyPort ?? 8080,
            workDir: path.join(this.userData, 'muse4ai'),
            secrets: this.secretStore,
            getApiKey: () => this.getApiKey(),
            logger: this.logger,
            spawn: (exe, args) => {
              const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
              child.on('error', () => this.logger.error('muse4ai.spawn_failed'));
              child.unref();
            },
            fetch: (url, init) =>
              fetch(url, { headers: init?.headers, redirect: 'manual', signal: AbortSignal.timeout(5000) }),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
          })
        : null;

    // 9c. Calendar Compositor (bundled sidecar, ADR-004). Missing sidecar => calendar jobs fail safely at
    // post-process with CALENDAR_COMPOSITING_FAILED; apparel is unaffected.
    this.compositor = opts.compositor ?? this.createCompositor(tempDir);

    // 10. Job Orchestrator
    this.orchestrator = new JobOrchestrator({
      db: this.db,
      media: this.media,
      prompts: this.prompts,
      provider: this.provider,
      config: this.config,
      logger: this.logger,
      imageStaging: this.imageStaging,
      compositor: this.compositor,
      imageEncoder: createElectronImageEncoder(),
      boardRenderer: createElectronBoardRenderer(),
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
      ...(this.muse4ai ? { setup: this.muse4ai.status() } : {}),
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
      bundle: this.bundle,
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

  private createCompositor(tempDir: string): CalendarArtworkCompositor & { dispose?(): void } {
    const resourcesDir = this.isPackaged
      ? ((process as unknown as { resourcesPath?: string }).resourcesPath ?? this.appPath)
      : path.join(this.appPath, 'vendor', 'calendar-compositor', 'dist');
    const exe = path.join(resourcesDir, 'calendar-compositor', 'calendar-compositor.exe');
    if (process.platform !== 'win32' || !fs.existsSync(exe)) {
      this.logger.warn('calendar_compositor_unavailable');
      return createUnavailableCompositor();
    }
    try {
      return createCalendarCompositor({ resourcesDir, tempDir, logger: this.logger });
    } catch {
      this.logger.error('calendar_compositor_init_failed');
      return createUnavailableCompositor();
    }
  }

  close(): void {
    this.orchestrator.stop();
    try {
      this.compositor.dispose?.();
    } catch {
      // ignore
    }
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
