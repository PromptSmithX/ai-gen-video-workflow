import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { PodError } from '@shared/errors';
import { DEFAULT_CATEGORIES, type Category } from '@shared/domain';
import type { AdminSettings, AppConfig, ProviderMode } from '@shared/config';

/**
 * Validates that a given URL string points strictly to a loopback address
 * (127.0.0.1, localhost, or [::1]). Rejects 0.0.0.0, LAN IPs, public hosts,
 * userinfo, query parameters, and fragments.
 * Never includes the invalid value in the error message.
 */
export function assertLoopbackUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new PodError('CONFIG_INVALID', 'Invalid bridgeBaseUrl: must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PodError('CONFIG_INVALID', 'Invalid bridgeBaseUrl: protocol must be http or https');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1';

  if (!isLoopback) {
    throw new PodError(
      'CONFIG_INVALID',
      'Invalid bridgeBaseUrl: hostname must be 127.0.0.1, localhost, or [::1]'
    );
  }

  if (parsed.username || parsed.password) {
    throw new PodError('CONFIG_INVALID', 'Invalid bridgeBaseUrl: credentials are not allowed');
  }

  if (parsed.search) {
    throw new PodError('CONFIG_INVALID', 'Invalid bridgeBaseUrl: query string is not allowed');
  }

  if (parsed.hash) {
    throw new PodError('CONFIG_INVALID', 'Invalid bridgeBaseUrl: fragment is not allowed');
  }
}

/**
 * Validates that a platform origin is an https URL with origin only (no path, query, hash, or userinfo).
 * Never includes the invalid value in the error message.
 */
export function assertPlatformOrigin(originStr: string): string {
  let parsed: URL;
  try {
    parsed = new URL(originStr);
  } catch {
    throw new PodError('CONFIG_INVALID', 'Invalid musePlatformOrigin: must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new PodError('CONFIG_INVALID', 'Invalid musePlatformOrigin: protocol must be https');
  }

  if (parsed.pathname && parsed.pathname !== '/') {
    throw new PodError('CONFIG_INVALID', 'Invalid musePlatformOrigin: path is not allowed');
  }

  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new PodError(
      'CONFIG_INVALID',
      'Invalid musePlatformOrigin: query, fragment, and credentials are not allowed'
    );
  }

  return parsed.origin;
}

/**
 * Checks that the data directory is not on a UNC network share.
 * Never includes the invalid path in the error message.
 */
export function assertDataDir(dataDir: string): void {
  const isUnc =
    dataDir.startsWith('\\\\') ||
    dataDir.startsWith('//') ||
    dataDir.startsWith('\\??\\UNC') ||
    dataDir.startsWith('\\\\?\\UNC');

  if (isUnc) {
    throw new PodError('CONFIG_INVALID', 'Invalid dataDir: UNC paths are not supported for dataDir');
  }
}

const categorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  promptGroup: z.enum(['apparel', 'drinkware', 'home-decor', 'other']),
});

const numberBoundsSchema = z.object({
  promptMaxChars: z.coerce.number().int().min(100).max(50000),
  pollIntervalMs: z.coerce.number().int().min(100).max(60000),
  pollMaxIntervalMs: z.coerce.number().int().min(500).max(300000),
  maxSourceBytes: z.coerce.number().int().min(1024).max(500 * 1024 * 1024),
  maxSourcePixels: z.coerce.number().int().min(1000).max(500000000),
  maxVideoBytes: z.coerce.number().int().min(1024 * 1024).max(10 * 1024 * 1024 * 1024),
  logRetentionDays: z.coerce.number().int().min(1).max(365),
});

/**
 * Checks whether a user is an admin.
 * Case-insensitive match against config.adminUsers.
 * In development mode with an empty adminUsers list, returns true.
 */
export function isAdmin(config: AppConfig, username?: string | null): boolean {
  if (config.isDev && config.adminUsers.length === 0) {
    return true;
  }
  if (!username) {
    return false;
  }
  const normalized = username.trim().toLowerCase();
  return config.adminUsers.some((admin) => admin.trim().toLowerCase() === normalized);
}

export interface LoadConfigArgs {
  env: NodeJS.ProcessEnv;
  settings: Partial<AdminSettings>;
  paths: {
    userData: string;
    documents: string;
  };
  isDev: boolean;
  envFilePath?: string;
}

export interface ReadEffectiveEnvArgs {
  env: NodeJS.ProcessEnv;
  isDev: boolean;
  userDataDir: string;
  envFilePath?: string;
  cwd?: string;
}

function cleanEnvVal(val: string | undefined): string | undefined {
  if (val === undefined) return undefined;
  const trimmed = val.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Reads and merges environment configuration from file (.env) and process environment.
 * In dev: reads from cwd (.env).
 * In installed / non-dev: reads optional .env from userDataDir.
 * If envFilePath is provided: reads from that path explicitly.
 * Treats blank/empty string values as unset.
 */
export function readEffectiveEnv(args: ReadEffectiveEnvArgs): Record<string, string | undefined> {
  let fileEnv: Record<string, string> = {};

  if (args.envFilePath) {
    if (existsSync(args.envFilePath)) {
      const content = readFileSync(args.envFilePath, 'utf-8');
      fileEnv = dotenv.parse(content);
    } else {
      throw new PodError('CONFIG_INVALID', 'Invalid configuration for key: envFilePath');
    }
  } else if (args.isDev) {
    const baseDir = args.cwd ?? resolve('.');
    const defaultEnvPath = join(baseDir, '.env');
    if (existsSync(defaultEnvPath)) {
      const content = readFileSync(defaultEnvPath, 'utf-8');
      fileEnv = dotenv.parse(content);
    }
  } else {
    // Installed / production app: check optional .env in userDataDir
    const prodEnvPath = join(args.userDataDir, '.env');
    if (existsSync(prodEnvPath)) {
      const content = readFileSync(prodEnvPath, 'utf-8');
      fileEnv = dotenv.parse(content);
    }
  }

  // Combine dotenv file and args.env.
  // Treat empty/blank string values as unset so they fall back to defaults.
  const effectiveEnv: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(fileEnv)) {
    const cleaned = cleanEnvVal(val);
    if (cleaned !== undefined) {
      effectiveEnv[key] = cleaned;
    }
  }
  for (const [key, val] of Object.entries(args.env)) {
    const cleaned = cleanEnvVal(val);
    if (cleaned !== undefined) {
      effectiveEnv[key] = cleaned;
    } else if (val !== undefined && val.trim() === '') {
      delete effectiveEnv[key];
    }
  }

  return effectiveEnv;
}

/**
 * Loads and validates application configuration.
 * Merges environment variables (.env via dotenv) and admin settings.
 * Empty env values are treated as unset and fall back to defaults.
 * Supports optional .env in paths.userData when not dev.
 * On validation failure, throws PodError('CONFIG_INVALID') with a message
 * naming the offending key, never the value.
 */
export function loadConfig(args: {
  env: NodeJS.ProcessEnv;
  settings: Partial<AdminSettings>;
  paths: { userData: string; documents: string };
  isDev: boolean;
  envFilePath?: string;
}): AppConfig {
  const effectiveEnv = readEffectiveEnv({
    env: args.env,
    isDev: args.isDev,
    userDataDir: args.paths.userData,
    envFilePath: args.envFilePath,
  });

  // Provider mode
  const rawProviderMode = effectiveEnv['PROVIDER_MODE'] || 'mock';
  if (rawProviderMode !== 'mock' && rawProviderMode !== 'bridge') {
    throw new PodError('CONFIG_INVALID', 'Invalid configuration for key: providerMode');
  }
  const providerMode = rawProviderMode as ProviderMode;

  // Bridge base URL (normalize by stripping trailing slashes for clean URL concatenation)
  let bridgeBaseUrl: string | null = null;
  const bridgeBaseUrlRaw =
    args.settings.bridgeBaseUrl !== undefined
      ? args.settings.bridgeBaseUrl
      : effectiveEnv['MUSE_BRIDGE_BASE_URL'] || null;

  if (bridgeBaseUrlRaw && bridgeBaseUrlRaw.trim() !== '') {
    assertLoopbackUrl(bridgeBaseUrlRaw.trim());
    let normalized = bridgeBaseUrlRaw.trim();
    while (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    bridgeBaseUrl = normalized;
  }

  // Muse platform origin
  let musePlatformOrigin: string | null = null;
  const musePlatformOriginRaw =
    args.settings.musePlatformOrigin !== undefined
      ? args.settings.musePlatformOrigin
      : effectiveEnv['MUSE_PLATFORM_ORIGIN'] || null;

  if (musePlatformOriginRaw && musePlatformOriginRaw.trim() !== '') {
    musePlatformOrigin = assertPlatformOrigin(musePlatformOriginRaw.trim());
  }

  // Prompt master path
  const promptMasterPath = effectiveEnv['PROMPT_MASTER_PATH']?.trim() || null;

  // Library root: settings override env default, default is <documents>/POD_VIDEO_LIBRARY
  let libraryRoot: string;
  if (args.settings.libraryRoot && args.settings.libraryRoot.trim() !== '') {
    libraryRoot = args.settings.libraryRoot.trim();
  } else if (effectiveEnv['POD_LIBRARY_ROOT'] && effectiveEnv['POD_LIBRARY_ROOT'].trim() !== '') {
    libraryRoot = effectiveEnv['POD_LIBRARY_ROOT'].trim();
  } else {
    libraryRoot = join(args.paths.documents, 'POD_VIDEO_LIBRARY');
  }

  // Data dir
  const dataDir = args.paths.userData;
  assertDataDir(dataDir);

  // Numbers & Bounds validation (empty values fall back to defaults)
  const promptMaxCharsRaw = effectiveEnv['PROMPT_MAX_CHARS'] ?? 4000;
  const pollIntervalMsRaw = effectiveEnv['POLL_INTERVAL_MS'] ?? 3000;
  const pollMaxIntervalMsRaw = effectiveEnv['POLL_MAX_INTERVAL_MS'] ?? 15000;

  let maxSourceBytesRaw: number | string = 15 * 1024 * 1024;
  if (effectiveEnv['MAX_SOURCE_MB']) {
    maxSourceBytesRaw = Number(effectiveEnv['MAX_SOURCE_MB']) * 1024 * 1024;
  } else if (effectiveEnv['MAX_SOURCE_BYTES']) {
    maxSourceBytesRaw = effectiveEnv['MAX_SOURCE_BYTES'];
  }

  const maxSourcePixelsRaw = effectiveEnv['MAX_SOURCE_PIXELS'] ?? 50000000;

  let maxVideoBytesRaw: number | string = 500 * 1024 * 1024;
  if (effectiveEnv['MAX_VIDEO_MB']) {
    maxVideoBytesRaw = Number(effectiveEnv['MAX_VIDEO_MB']) * 1024 * 1024;
  } else if (effectiveEnv['MAX_VIDEO_BYTES']) {
    maxVideoBytesRaw = effectiveEnv['MAX_VIDEO_BYTES'];
  }

  const logRetentionDaysRaw =
    args.settings.logRetentionDays !== undefined
      ? args.settings.logRetentionDays
      : effectiveEnv['LOG_RETENTION_DAYS'] ?? 30;

  const numberParseResult = numberBoundsSchema.safeParse({
    promptMaxChars: promptMaxCharsRaw,
    pollIntervalMs: pollIntervalMsRaw,
    pollMaxIntervalMs: pollMaxIntervalMsRaw,
    maxSourceBytes: maxSourceBytesRaw,
    maxSourcePixels: maxSourcePixelsRaw,
    maxVideoBytes: maxVideoBytesRaw,
    logRetentionDays: logRetentionDaysRaw,
  });

  if (!numberParseResult.success) {
    const issue = numberParseResult.error.issues[0];
    const key = issue?.path.join('.') || 'numeric field';
    throw new PodError('CONFIG_INVALID', `Invalid configuration for key: ${key}`);
  }

  const numbers = numberParseResult.data;

  if (numbers.pollIntervalMs > numbers.pollMaxIntervalMs) {
    throw new PodError(
      'CONFIG_INVALID',
      'Invalid configuration for key: pollIntervalMs (must not exceed pollMaxIntervalMs)'
    );
  }

  // Admin users: settings override env defaults
  let adminUsers: string[] = [];
  if (args.settings.adminUsers !== undefined) {
    adminUsers = args.settings.adminUsers.map((u) => u.trim()).filter(Boolean);
  } else if (effectiveEnv['POD_ADMIN_USERS']) {
    adminUsers = effectiveEnv['POD_ADMIN_USERS']
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }

  // Categories: settings override default
  let categories: Category[] = DEFAULT_CATEGORIES;
  if (args.settings.categories !== undefined) {
    const catResult = z.array(categorySchema).safeParse(args.settings.categories);
    if (!catResult.success) {
      throw new PodError('CONFIG_INVALID', 'Invalid configuration for key: categories');
    }
    categories = catResult.data;
  }

  return {
    providerMode,
    musePlatformOrigin,
    bridgeBaseUrl,
    promptMasterPath,
    libraryRoot,
    dataDir,
    promptMaxChars: numbers.promptMaxChars,
    pollIntervalMs: numbers.pollIntervalMs,
    pollMaxIntervalMs: numbers.pollMaxIntervalMs,
    maxSourceBytes: numbers.maxSourceBytes,
    maxSourcePixels: numbers.maxSourcePixels,
    maxVideoBytes: numbers.maxVideoBytes,
    logRetentionDays: numbers.logRetentionDays,
    adminUsers,
    categories,
    isDev: args.isDev,
  };
}
