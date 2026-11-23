/** Effective application configuration (env defaults + admin settings). Loaded/validated in main only. */
import type { Category } from './domain';

export type ProviderMode = 'mock' | 'bridge';

export interface AppConfig {
  providerMode: ProviderMode;
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
