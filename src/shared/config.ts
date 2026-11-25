/** Effective application configuration (env defaults + admin settings). Loaded/validated in main only. */
import type { Category } from './domain';

export type ProviderMode = 'mock' | 'bridge';

/**
 * How the bridge submits a generation. `chat` sends the full prompt verbatim to Muse (Muse4AI chat, ≤ 32000 chars)
 * with the mockup attached; `video` uses the dedicated video job (≤ 4000 chars). Default: chat.
 */
export type MuseSubmitMode = 'chat' | 'video';

export interface AppConfig {
  providerMode: ProviderMode;
  /** Bridge submit path (MUSE_SUBMIT_MODE). Undefined = 'chat'. */
  museSubmitMode?: MuseSubmitMode;
  /** Exact origin of the Muse product employees use, or null when not yet recorded. */
  musePlatformOrigin: string | null;
  /** Loopback-only bridge base URL (validated), or null when not configured. */
  bridgeBaseUrl: string | null;
  /** Absolute path of the company Prompt Master file, or null (use placeholder). */
  promptMasterPath: string | null;
  /** Absolute library root (POD_VIDEO_LIBRARY). */
  libraryRoot: string;
  /** Local app data dir: SQLite db, logs, temp. Never on a network share. */
  dataDir: string;
  promptMaxChars: number;
  pollIntervalMs: number;
  pollMaxIntervalMs: number;
  maxSourceBytes: number;
  maxSourcePixels: number;
  maxVideoBytes: number;
  logRetentionDays: number;
  adminUsers: string[];
  categories: Category[];
  isDev: boolean;
  /** Bundled (patched) Muse4AI executable POD starts and provisions, or null (bridge managed by hand). */
  muse4aiExePath?: string | null;
  /** Loopback port of the forward proxy the bundled Muse4AI runs for this machine (MUSE4AI_PROXY_PORT). */
  muse4aiProxyPort?: number;
}

/** Files shipped with the installer that change the defaults (see `loadConfig`). */
export interface BundledResources {
  muse4aiExePath: string | null;
  promptMasterPath: string | null;
}

/** Admin-editable subset (persisted in the settings table). */
export interface AdminSettings {
  bridgeBaseUrl: string | null;
  musePlatformOrigin: string | null;
  libraryRoot: string;
  logRetentionDays: number;
  categories: Category[];
  adminUsers: string[];
  defaultTemplateId: string | null;
  defaultTemplateVersion: string | null;
}
