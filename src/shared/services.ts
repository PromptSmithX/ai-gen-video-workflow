/**
 * Main-process module contracts. Type-only: implemented by the infra/prompt/provider modules and consumed by
 * the job orchestrator + IPC layer. Changing these requires the lead's approval.
 */
import type { AppConfig } from './config';
import type { Asset, ImageInfo, Job, Product, ReviewStatus } from './domain';
import type { ErrorCode } from './errors';
import type { JobState } from './job-state';
import type { MuseProvider } from './provider';
import type {
  PromptTemplate,
  PromptTemplateSummary,
  PromptVariables,
  QualityReport,
  RenderedPrompt,
} from './prompt';

// ---------------------------------------------------------------------------------------------------------------
// Database (src/main/infra/db) — factory: `openDatabase(filePath: string): PodDatabase`
// ---------------------------------------------------------------------------------------------------------------

export interface ProductRepository {
  /** Insert or update category/productName for a normalized SKU. */
  upsertBySku(input: { sku: string; category: string; productName: string | null }): Product;
  getById(id: string): Product | null;
  getBySku(sku: string): Product | null;
  list(): Product[];
}

export type NewJob = Omit<
  Job,
  | 'createdAt'
  | 'updatedAt'
  | 'providerJobId'
  | 'providerReferenceId'
  | 'providerAssetId'
  | 'submitIntentAt'
  | 'acceptedAt'
  | 'completedAt'
  | 'errorCode'
  | 'safeErrorMessage'
  | 'reviewStatus'
  | 'attempt'
  | 'state'
> & { state?: JobState };

export type JobPatch = Partial<
  Pick<
    Job,
    | 'providerJobId'
    | 'providerReferenceId'
    | 'providerAssetId'
    | 'submitIntentAt'
    | 'acceptedAt'
    | 'completedAt'
    | 'errorCode'
    | 'safeErrorMessage'
    | 'attempt'
    | 'reviewStatus'
  >
>;

export interface JobFilter {
  sku?: string;
  category?: string;
  employeeId?: string;
  states?: JobState[];
  templateVersion?: string;
  reviewStatus?: ReviewStatus;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface JobRepository {
  /** Inserts a QUEUED job (or given state). Throws PodError('INVALID_STATE') on duplicate idempotencyKey. */
  insert(job: NewJob): Job;
  getById(id: string): Job | null;
  findByIdempotencyKey(key: string): Job | null;
  /** Jobs in ACTIVE_JOB_STATES, oldest first. */
  listActive(): Job[];
  /** Newest first. */
  list(filter?: JobFilter): Job[];
  /**
   * Atomically moves a job from its current state to `to` (validated with canTransition) and applies `patch`.
   * Throws PodError('INVALID_STATE') if the transition is not allowed or the job changed concurrently.
   */
  transition(id: string, to: JobState, patch?: JobPatch): Job;
  /** Updates non-state fields only. */
  update(id: string, patch: JobPatch): Job;
}

export interface AssetRepository {
  insert(asset: Omit<Asset, 'id' | 'createdAt'>): Asset;
  getById(id: string): Asset | null;
  listByJob(jobId: string): Asset[];
  listByProduct(productId: string): Asset[];
  delete(id: string): void;
}

export interface SettingsRepository {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

export interface PodDatabase {
  readonly products: ProductRepository;
  readonly jobs: JobRepository;
  readonly assets: AssetRepository;
  readonly settings: SettingsRepository;
  transaction<T>(fn: () => T): T;
  /** Online backup to a file (used by backup/restore + tests). */
  backup(destPath: string): Promise<void>;
  close(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Media library (src/main/infra/media) — factory:
//   `createMediaLibrary(opts: { root: string; tempDir: string; maxSourceBytes: number; maxSourcePixels: number;
//                               maxVideoBytes: number }): MediaLibrary`
// ---------------------------------------------------------------------------------------------------------------

export interface StoredFile {
  /** Relative to library root, forward slashes. */
  relPath: string;
  absPath: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

export interface MediaLibrary {
  readonly root: string;
  /** Validates real signature (PNG/JPEG/WEBP), byte size and pixel count. Throws INVALID_IMAGE / IMAGE_TOO_LARGE. */
  validateImage(absPath: string): Promise<ImageInfo>;
  /** Byte-identical copy into <SKU>/source/<SKU>-original[-N].<ext>. Never recompresses. */
  importSourceImage(absPath: string, sku: string): Promise<StoredFile>;
  /** Writes <SKU>/prompts/<SKU>-prompt-<label>.md */
  writePromptSnapshot(sku: string, label: string, text: string): Promise<StoredFile>;
  /** New unique temp file path (in the private temp dir) ending in `.part`. */
  newTempPath(): string;
  /**
   * Validates MP4 container signature + size, hashes it and atomically moves it to
   * <SKU>/videos/<SKU>-video-NNN.mp4 (next free NNN). Deletes the temp file on failure.
   * Throws PodError('DOWNLOAD_FAILED').
   */
  storeVideo(tempPartPath: string, sku: string): Promise<StoredFile>;
  /** Writes <SKU>/metadata/<baseName>.json (sanitized metadata only). */
  writeMetadata(sku: string, baseName: string, data: Record<string, unknown>): Promise<StoredFile>;
  /** Absolute path for a stored relative path; throws if it escapes the root (traversal/symlink/junction). */
  resolve(relPath: string): string;
  skuDir(sku: string): string;
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts (src/main/prompts) — factory:
//   `createPromptService(opts: { builtinDir: string; adminDir: string; companyMasterPath: string | null }): PromptService`
// ---------------------------------------------------------------------------------------------------------------

export interface RenderArgs {
  templateId: string;
  /** Omit = default/latest version. */
  templateVersion?: string;
  variables: PromptVariables;
  /** prompts/categories/<group>.md appended per template rules. */
  categoryGroup: string;
  maxChars: number;
  supportsDuration: boolean;
  supportsAspectRatio: boolean;
}

export interface PromptService {
  listTemplates(): PromptTemplateSummary[];
  /** Throws PodError('TEMPLATE_NOT_FOUND'). Omit version = default/latest. */
  getTemplate(id: string, version?: string): PromptTemplate;
  render(args: RenderArgs): RenderedPrompt;
  /** Validates an employee-edited prompt override. */
  validatePrompt(text: string, maxChars: number): { quality: QualityReport; errors: string[] };
  /** Admin: saves a NEW version (never overwrites). */
  saveTemplateVersion(args: { id: string; title?: string; body: string; note?: string }): PromptTemplateSummary;
  setDefault(id: string, version: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets / logging / config (src/main/infra/{secrets,logging,config})
// ---------------------------------------------------------------------------------------------------------------

export type SecretName = 'bridge_api_key';

export interface SecretStore {
  /** False when OS encryption (DPAPI via safeStorage) is unavailable. */
  isAvailable(): boolean;
  get(name: SecretName): string | null;
  /** Throws PodError('SECRET_STORE_UNAVAILABLE') when encryption is unavailable. NO plaintext fallback. */
  set(name: SecretName, value: string): void;
  delete(name: SecretName): void;
}

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface ProviderFactoryDeps {
  config: AppConfig;
  /** Reads the bridge API key on demand (secret store first, then env in dev). Never cached in logs. */
  getApiKey: () => string | null;
  logger: Logger;
}

/** Signature of `createMuseProvider` in src/main/providers/muse/index.ts */
export type MuseProviderFactory = (deps: ProviderFactoryDeps) => MuseProvider;

/** Safe error info stored on a job. */
export interface JobFailure {
  code: ErrorCode;
  message: string;
}
