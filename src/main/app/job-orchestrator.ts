import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '@shared/config';
import type { Asset, Job, ReviewStatus } from '@shared/domain';
import { normalizeSku } from '@shared/domain';
import { PodError, SAFE_ERROR_MESSAGES } from '@shared/errors';
import type { CreateJobInput, JobView } from '@shared/ipc';
import { JOB_STATE_LABELS } from '@shared/job-state';
import type { MuseProvider, ProviderCapabilities, ProviderJob } from '@shared/provider';
import { ProviderError } from '@shared/provider';
import type {
  CalendarArtworkCompositor,
  CalendarCompositionReport,
  JobFilter,
  Logger,
  MediaLibrary,
  PodDatabase,
  PromptService,
  StoredFile,
} from '@shared/services';
import { newId, nowIso } from '../domain/ids';
import { isTerminal, nextActionsFor } from '../domain/job-machine';
import { hashFile } from '../infra/media/hash';
import { prepareUploadImage, type PreparedUploadImage, type UploadImageEncoder } from '../infra/media/upload-image';
import { nextPollDelay } from '../providers/muse/poll';
import type { ImageStagingService, StagedImageRecord } from './image-staging';
import { createUnavailableCompositor } from './unavailable-compositor';

export interface OrchestratorDeps {
  db: PodDatabase;
  media: MediaLibrary;
  prompts: PromptService;
  provider: MuseProvider;
  config: AppConfig;
  logger: Logger;
  imageStaging: ImageStagingService;
  compositor: CalendarArtworkCompositor;
  /**
   * Re-encodes a front cover that exceeds the provider upload limit (library original untouched).
   * Absent => oversized images are passed through and the provider rejects them as before.
   */
  imageEncoder?: UploadImageEncoder;
  /** Max concurrent active generations. Defaults to 1. */
  maxConcurrent?: number;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  canCancel: false,
  reportsProgress: false,
  supportedDurations: [],
  supportedAspectRatios: [],
  maxPromptChars: 4000,
  maxUploadBytes: 20 * 1024 * 1024,
};

export class JobOrchestrator extends EventEmitter {
  private readonly db: PodDatabase;
  private readonly media: MediaLibrary;
  private readonly prompts: PromptService;
  private provider: MuseProvider;
  private config: AppConfig;
  private readonly logger: Logger;
  private readonly imageStaging: ImageStagingService;
  private readonly compositor: CalendarArtworkCompositor;
  private readonly imageEncoder: UploadImageEncoder | undefined;
  private readonly maxConcurrent: number;

  private isProcessing = false;
  private hasPendingWork = false;
  private stopped = false;
  private pollAttempt = 0;
  private readonly jobProgress = new Map<string, number>();
  private sleepAbortController: AbortController | null = null;

  constructor(deps: OrchestratorDeps) {
    super();
    this.db = deps.db;
    this.media = deps.media;
    this.prompts = deps.prompts;
    this.provider = deps.provider;
    this.config = deps.config;
    this.logger = deps.logger;
    this.imageStaging = deps.imageStaging;
    this.compositor = deps.compositor ?? createUnavailableCompositor();
    this.imageEncoder = deps.imageEncoder;
    this.maxConcurrent = deps.maxConcurrent ?? 1;
  }

  setProvider(provider: MuseProvider): void {
    this.provider = provider;
  }

  setConfig(config: AppConfig): void {
    this.config = config;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    try {
      return await this.provider.getCapabilities();
    } catch {
      return DEFAULT_CAPABILITIES;
    }
  }

  /**
   * Startup recovery:
   * - QUEUED -> stays queued
   * - SUBMITTING -> AMBIGUOUS (we cannot know if it was sent)
   * - RUNNING -> resume polling
   * - DOWNLOADING -> retry download
   * Never resubmit.
   */
  async recover(): Promise<void> {
    const activeJobs = this.db.jobs.listActive();
    for (const job of activeJobs) {
      if (job.state === 'SUBMITTING') {
        this.db.jobs.transition(job.id, 'AMBIGUOUS', {
          errorCode: 'SUBMIT_AMBIGUOUS',
          safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
        });
        this.logger.warn('job_recovered_ambiguous', {
          jobId: job.id,
          sku: job.skuSnapshot,
        });
        await this.emitJobUpdated(job.id);
      } else if (job.state === 'DOWNLOADING') {
        this.logger.info('job_recovered_downloading', {
          jobId: job.id,
          sku: job.skuSnapshot,
        });
      } else if (job.state === 'RUNNING') {
        this.logger.info('job_recovered_running', {
          jobId: job.id,
          sku: job.skuSnapshot,
        });
      }
    }

    this.scheduleProcessQueue();
  }

  /**
   * Creates a new video generation job or returns existing if clientRequestId was already used.
   */
  async createJob(input: CreateJobInput, employeeId: string): Promise<JobView> {
    const normalizedSku = normalizeSku(input.sku);
    if (!normalizedSku) {
      throw new PodError('INVALID_SKU');
    }

    const stagedSource = this.imageStaging.get(input.sourceToken);
    if (!stagedSource) {
      throw new PodError('INVALID_IMAGE', 'Staged image token expired or invalid');
    }

    const category = this.config.categories.find((c) => c.id === input.categoryId);
    if (!category) {
      throw new PodError('CONFIG_INVALID', 'Category not found in configuration');
    }

    const isCalendar = category.promptGroup === 'calendar';
    let stagedArtwork: StagedImageRecord | null = null;
    if (isCalendar) {
      if (!input.interiorArtworkToken) {
        throw new PodError('INVALID_IMAGE', 'Interior artwork is required for Desk Calendar');
      }
      const staged = this.imageStaging.get(input.interiorArtworkToken);
      if (!staged) {
        throw new PodError('INVALID_IMAGE', 'Interior artwork token expired or invalid');
      }
      stagedArtwork = staged;
    }

    // Validate images before any import
    await this.media.validateImage(stagedSource.absPath);
    if (isCalendar && stagedArtwork) {
      await this.media.validateImage(stagedArtwork.absPath);
    }

    // Ensure template exists
    this.prompts.getTemplate(input.templateId, input.templateVersion);

    // Validate prompt override or render prompt template
    let promptText: string;
    if (input.promptOverride && input.promptOverride.trim().length > 0) {
      const validated = this.prompts.validatePrompt(input.promptOverride, this.config.promptMaxChars);
      if (validated.errors.length > 0 || !validated.quality.passed) {
        const code = validated.errors.some((e) => e.startsWith('PROMPT_TOO_LONG'))
          ? 'PROMPT_TOO_LONG'
          : 'INVALID_PROMPT';
        throw new PodError(code, validated.errors[0] || 'Prompt quality check failed');
      }
      promptText = input.promptOverride;
    } else {
      const caps = await this.getCapabilities();
      const rendered = this.prompts.render({
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        variables: {
          sku: normalizedSku,
          product_category: category.label,
          product_name: input.productName,
          source_image_filename: stagedSource.fileName,
          duration_seconds: input.durationSeconds,
          aspect_ratio: input.aspectRatio,
          review_style: input.reviewStyle,
        },
        categoryGroup: category.promptGroup,
        maxChars: this.config.promptMaxChars,
        supportsDuration: caps.supportedDurations.length > 0,
        supportsAspectRatio: caps.supportedAspectRatios.length > 0,
      });

      if (rendered.errors.length > 0 || !rendered.quality.passed) {
        const code = rendered.errors.some((e) => e.startsWith('PROMPT_TOO_LONG'))
          ? 'PROMPT_TOO_LONG'
          : 'INVALID_PROMPT';
        throw new PodError(code, rendered.errors[0] || 'Prompt rendering or quality check failed');
      }
      promptText = rendered.text;
    }

    // Idempotency: return existing job if clientRequestId is already recorded
    const existing = this.db.jobs.findByIdempotencyKey(input.clientRequestId);
    if (existing) {
      return this.toJobView(existing);
    }

    // Perform async file operations before the single synchronous DB transaction
    const createdFiles: string[] = [];
    let sourceAssetFile: StoredFile | null = null;
    let artworkAssetFile: StoredFile | null = null;
    let promptSnapshotFile: StoredFile | null = null;

    const jobId = newId();
    let job: Job;
    try {
      sourceAssetFile = await this.media.importSourceImage(stagedSource.absPath, normalizedSku);
      createdFiles.push(sourceAssetFile.absPath);

      if (isCalendar && stagedArtwork) {
        artworkAssetFile = await this.media.importInteriorArtwork(stagedArtwork.absPath, normalizedSku);
        createdFiles.push(artworkAssetFile.absPath);
      }

      promptSnapshotFile = await this.media.writePromptSnapshot(
        normalizedSku,
        input.templateVersion || 'v1',
        promptText
      );
      createdFiles.push(promptSnapshotFile.absPath);

      job = this.db.transaction(() => {
        const product = this.db.products.upsertBySku({
          sku: normalizedSku,
          category: input.categoryId,
          productName: input.productName ?? null,
        });

        const sourceAsset = this.db.assets.insert({
          productId: product.id,
          jobId: null,
          role: 'source_image',
          path: sourceAssetFile!.relPath,
          mime: sourceAssetFile!.mime,
          bytes: sourceAssetFile!.bytes,
          width: sourceAssetFile!.width,
          height: sourceAssetFile!.height,
          durationMs: null,
          sha256: sourceAssetFile!.sha256,
        });

        const newJob = this.db.jobs.insert({
          id: jobId,
          productId: product.id,
          skuSnapshot: normalizedSku,
          employeeId,
          provider: 'muse',
          sourceAssetId: sourceAsset.id,
          promptTemplateId: input.templateId,
          promptTemplateVersion: input.templateVersion,
          promptSha256: promptSnapshotFile!.sha256,
          promptOverridden: Boolean(input.promptOverride && input.promptOverride.trim().length > 0),
          durationSeconds: input.durationSeconds ?? null,
          aspectRatio: input.aspectRatio ?? null,
          idempotencyKey: input.clientRequestId,
          regeneratedFromJobId: null,
        });

        if (isCalendar && artworkAssetFile) {
          this.db.assets.insert({
            productId: product.id,
            jobId: newJob.id,
            role: 'interior_artwork',
            path: artworkAssetFile.relPath,
            mime: artworkAssetFile.mime,
            bytes: artworkAssetFile.bytes,
            width: artworkAssetFile.width,
            height: artworkAssetFile.height,
            durationMs: null,
            sha256: artworkAssetFile.sha256,
          });
        }

        this.db.assets.insert({
          productId: product.id,
          jobId: newJob.id,
          role: 'prompt_snapshot',
          path: promptSnapshotFile!.relPath,
          mime: promptSnapshotFile!.mime,
          bytes: promptSnapshotFile!.bytes,
          width: null,
          height: null,
          durationMs: null,
          sha256: promptSnapshotFile!.sha256,
        });

        return newJob;
      });
    } catch (err) {
      // Best-effort cleanup of files if the transaction or file writing fails
      for (const filePath of createdFiles) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }

      // Check if duplicate key from idempotency race
      const existingAfterRace = this.db.jobs.findByIdempotencyKey(input.clientRequestId);
      if (existingAfterRace) {
        return this.toJobView(existingAfterRace);
      }

      throw err;
    }

    this.logger.info('job_created', {
      jobId: job.id,
      sku: job.skuSnapshot,
      employeeId,
    });

    this.scheduleProcessQueue();
    const view = await this.toJobView(job);
    this.emit('job:updated', view);
    return view;
  }

  async listJobs(filter?: JobFilter): Promise<JobView[]> {
    const jobs = this.db.jobs.list(filter);
    const caps = await this.getCapabilities();
    return Promise.all(jobs.map((j) => this.toJobView(j, caps)));
  }

  async getJob(jobId: string): Promise<JobView> {
    const job = this.db.jobs.getById(jobId);
    if (!job) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }
    return this.toJobView(job);
  }

  async retry(jobId: string, acknowledged: boolean): Promise<JobView> {
    if (!acknowledged) {
      throw new PodError('INVALID_STATE', 'Retry requires acknowledgement');
    }

    const job = this.db.jobs.getById(jobId);
    if (!job) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    const canRetry =
      job.state === 'FAILED_RETRYABLE' ||
      (job.state === 'FAILED_PROVIDER' && job.attempt < 2);

    if (!canRetry) {
      throw new PodError('INVALID_STATE', `Job in state ${job.state} (attempt ${job.attempt}) cannot be retried`);
    }

    const updated = this.db.jobs.transition(job.id, 'QUEUED', {
      attempt: job.attempt + 1,
      errorCode: null,
      safeErrorMessage: null,
    });

    this.logger.info('job_retried', {
      jobId: updated.id,
      sku: updated.skuSnapshot,
      attempt: updated.attempt,
    });

    this.scheduleProcessQueue();
    await this.emitJobUpdated(updated.id);
    return this.toJobView(updated);
  }

  async regenerate(jobId: string, confirmed: boolean, clientRequestId: string): Promise<JobView> {
    if (!confirmed) {
      throw new PodError('INVALID_STATE', 'Regeneration requires confirmation');
    }

    const original = this.db.jobs.getById(jobId);
    if (!original) {
      throw new PodError('NOT_FOUND', 'Original job not found');
    }

    if (!isTerminal(original.state)) {
      throw new PodError('INVALID_STATE', 'Cannot regenerate a non-terminal job');
    }

    const originalSnapshot = this.findPromptSnapshotAsset(original);
    if (!originalSnapshot) {
      throw new PodError('INVALID_STATE', 'Original prompt snapshot missing');
    }

    const originalArtwork = this.findInteriorArtworkAsset(original);
    const product = this.db.products.getById(original.productId);
    const category = this.config.categories.find((c) => c.id === product?.category);
    const isCalendar = originalArtwork !== undefined || category?.promptGroup === 'calendar';

    if (isCalendar) {
      if (!originalArtwork) {
        throw new PodError('NOT_FOUND', 'Original interior artwork asset missing');
      }

      let artworkAbsPath: string;
      try {
        artworkAbsPath = this.media.resolve(originalArtwork.path);
      } catch {
        throw new PodError('NOT_FOUND', 'Original interior artwork file missing');
      }

      if (!fs.existsSync(artworkAbsPath)) {
        throw new PodError('NOT_FOUND', 'Original interior artwork file missing');
      }

      const calculatedSha256 = await hashFile(artworkAbsPath);
      if (calculatedSha256 !== originalArtwork.sha256) {
        throw new PodError('INVALID_IMAGE', 'Original interior artwork hash mismatch');
      }
    }

    const newJobId = newId();
    const newJob = this.db.transaction(() => {
      const inserted = this.db.jobs.insert({
        id: newJobId,
        productId: original.productId,
        skuSnapshot: original.skuSnapshot,
        employeeId: original.employeeId,
        provider: 'muse',
        sourceAssetId: original.sourceAssetId,
        promptTemplateId: original.promptTemplateId,
        promptTemplateVersion: original.promptTemplateVersion,
        promptSha256: original.promptSha256,
        promptOverridden: original.promptOverridden,
        durationSeconds: original.durationSeconds,
        aspectRatio: original.aspectRatio,
        idempotencyKey: clientRequestId,
        regeneratedFromJobId: original.id,
      });
      // The regenerated job reuses the original prompt snapshot file (same text, same sha256).
      this.db.assets.insert({
        productId: originalSnapshot.productId,
        jobId: inserted.id,
        role: 'prompt_snapshot',
        path: originalSnapshot.path,
        mime: originalSnapshot.mime,
        bytes: originalSnapshot.bytes,
        width: null,
        height: null,
        durationMs: null,
        sha256: originalSnapshot.sha256,
      });
      if (isCalendar && originalArtwork) {
        this.db.assets.insert({
          productId: originalArtwork.productId,
          jobId: inserted.id,
          role: 'interior_artwork',
          path: originalArtwork.path,
          mime: originalArtwork.mime,
          bytes: originalArtwork.bytes,
          width: originalArtwork.width,
          height: originalArtwork.height,
          durationMs: null,
          sha256: originalArtwork.sha256,
        });
      }
      return inserted;
    });

    this.logger.info('job_regenerated', {
      jobId: newJob.id,
      originalJobId: original.id,
      sku: newJob.skuSnapshot,
    });

    this.scheduleProcessQueue();
    await this.emitJobUpdated(newJob.id);
    return this.toJobView(newJob);
  }

  async resolveAmbiguous(jobId: string, resolution: 'check_again' | 'mark_failed'): Promise<JobView> {
    const job = this.db.jobs.getById(jobId);
    if (!job) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    if (job.state !== 'AMBIGUOUS') {
      throw new PodError('INVALID_STATE', `Job is in state ${job.state}, expected AMBIGUOUS`);
    }

    if (resolution === 'check_again') {
      // Never resubmits. With a provider job id we can simply re-read the job (e.g. Muse4AI "needs_review"
      // that a person resolved in Muse4AI); without one, only an id lookup could reconcile it.
      let found: ProviderJob | null = null;
      try {
        if (job.providerJobId) {
          found = await this.provider.getJob(job.providerJobId);
        } else if (this.provider.findJobByRequestId) {
          found = await this.provider.findJobByRequestId(job.idempotencyKey);
        }
      } catch {
        found = null; // Stay in AMBIGUOUS if provider query fails
      }
      if (found && (found.state === 'running' || found.state === 'queued' || found.state === 'succeeded')) {
        const updated = this.db.jobs.transition(job.id, 'RUNNING', {
          providerJobId: found.providerJobId || job.providerJobId,
          providerReferenceId: found.providerReferenceId ?? job.providerReferenceId ?? null,
          acceptedAt: job.acceptedAt ?? nowIso(),
          errorCode: null,
          safeErrorMessage: null,
        });
        this.logger.info('job_ambiguous_reconciled', {
          jobId: updated.id,
          providerJobId: updated.providerJobId,
        });
        this.scheduleProcessQueue();
        await this.emitJobUpdated(updated.id);
        return this.toJobView(updated);
      }
      if (found && (found.state === 'failed' || found.state === 'cancelled')) {
        const updated =
          found.state === 'cancelled'
            ? this.db.jobs.transition(job.id, 'CANCELLED')
            : this.db.jobs.transition(job.id, 'FAILED_PROVIDER', {
                errorCode: found.errorCode ?? 'PROVIDER_ERROR',
                safeErrorMessage: found.safeMessage ?? SAFE_ERROR_MESSAGES.PROVIDER_ERROR,
              });
        await this.emitJobUpdated(updated.id);
        return this.toJobView(updated);
      }
      // Still unknown -> stays in AMBIGUOUS
      return this.toJobView(job);
    } else {
      // resolution === 'mark_failed'
      const updated = this.db.jobs.transition(job.id, 'FAILED_PROVIDER', {
        errorCode: 'PROVIDER_ERROR',
        safeErrorMessage: 'Marked failed by user.',
      });
      this.logger.info('job_ambiguous_marked_failed', {
        jobId: updated.id,
        sku: updated.skuSnapshot,
      });
      await this.emitJobUpdated(updated.id);
      return this.toJobView(updated);
    }
  }

  async retryDownload(jobId: string): Promise<JobView> {
    const job = this.db.jobs.getById(jobId);
    if (!job) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    if (job.state !== 'DOWNLOAD_FAILED') {
      throw new PodError('INVALID_STATE', `Job is in state ${job.state}, expected DOWNLOAD_FAILED`);
    }

    const updated = this.db.jobs.transition(job.id, 'DOWNLOADING', {
      errorCode: null,
      safeErrorMessage: null,
    });

    this.logger.info('job_retry_download', {
      jobId: updated.id,
      sku: updated.skuSnapshot,
    });

    this.scheduleProcessQueue();
    await this.emitJobUpdated(updated.id);
    return this.toJobView(updated);
  }

  async cancel(jobId: string): Promise<JobView> {
    const job = this.db.jobs.getById(jobId);
    if (!job) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    if (job.state !== 'QUEUED' && job.state !== 'RUNNING') {
      throw new PodError('INVALID_STATE', `Cannot cancel job in state ${job.state}`);
    }

    const caps = await this.getCapabilities();
    if (!caps.canCancel) {
      throw new PodError('INVALID_STATE', 'Cancellation is not supported by the provider');
    }

    if (job.state === 'RUNNING' && job.providerJobId && this.provider.cancelJob) {
      try {
        await this.provider.cancelJob(job.providerJobId);
      } catch (err: unknown) {
        const code = err instanceof PodError ? err.code : 'PROVIDER_ERROR';
        this.logger.warn('job_cancel_provider_failed', {
          jobId: job.id,
          code,
        });
        throw new PodError('PROVIDER_ERROR', 'Failed to cancel job with provider');
      }
    }

    const updated = this.db.jobs.transition(job.id, 'CANCELLED');
    this.abortSleep();
    this.logger.info('job_cancelled', {
      jobId: updated.id,
      sku: updated.skuSnapshot,
    });
    await this.emitJobUpdated(updated.id);
    return this.toJobView(updated);
  }

  setReview(jobId: string, status: ReviewStatus): JobView {
    const job = this.db.jobs.getById(jobId);
    if (!job) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    const updated = this.db.jobs.update(job.id, { reviewStatus: status });
    void this.emitJobUpdated(updated.id);
    return this.toJobViewSync(updated);
  }

  stop(): void {
    this.stopped = true;
    this.abortSleep();
  }

  private abortSleep(): void {
    if (this.sleepAbortController) {
      this.sleepAbortController.abort();
      this.sleepAbortController = null;
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.sleepAbortController = new AbortController();
    const { signal } = this.sleepAbortController;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);

      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      });
    }).finally(() => {
      this.sleepAbortController = null;
    });
  }

  private scheduleProcessQueue(): void {
    this.hasPendingWork = true;
    if (this.isProcessing || this.stopped) return;
    void this.processQueue();
  }

  /**
   * Authoritative single-flight worker loop: at most `maxConcurrent` (1) provider generation.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.stopped) return;
    this.isProcessing = true;

    try {
      while (!this.stopped) {
        this.hasPendingWork = false;
        const activeJobs = this.db.jobs.listActive();

        // 1. Process any job currently in DOWNLOADING state
        const downloadingJob = activeJobs.find((j) => j.state === 'DOWNLOADING');
        if (downloadingJob) {
          try {
            await this.handleDownloading(downloadingJob);
          } catch (err) {
            this.logger.error('download_handler_error', {
              jobId: downloadingJob.id,
              error: (err as PodError)?.code ?? 'DOWNLOAD_FAILED',
            });
            try {
              this.db.jobs.transition(downloadingJob.id, 'DOWNLOAD_FAILED', {
                errorCode: 'DOWNLOAD_FAILED',
                safeErrorMessage: SAFE_ERROR_MESSAGES.DOWNLOAD_FAILED,
              });
              await this.emitJobUpdated(downloadingJob.id);
            } catch {
              // ignore
            }
            await this.sleep(100);
          }
          continue;
        }

        // 2. Poll any job currently in RUNNING state
        const runningJob = activeJobs.find((j) => j.state === 'RUNNING');
        if (runningJob) {
          try {
            await this.handleRunning(runningJob);
          } catch (err) {
            this.logger.error('running_handler_error', {
              jobId: runningJob.id,
              error: (err as PodError)?.code ?? 'PROVIDER_ERROR',
            });
            // RUNNING stays RUNNING per spec, backoff sleep so loop doesn't spin
            await this.sleep(250);
          }
          continue;
        }

        // 3. Handle leftover SUBMITTING job (reconcile to AMBIGUOUS)
        const submittingJob = activeJobs.find((j) => j.state === 'SUBMITTING');
        if (submittingJob) {
          try {
            this.db.jobs.transition(submittingJob.id, 'AMBIGUOUS', {
              errorCode: 'SUBMIT_AMBIGUOUS',
              safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
            });
            await this.emitJobUpdated(submittingJob.id);
          } catch (err) {
            this.logger.error('submitting_reconcile_error', {
              jobId: submittingJob.id,
              error: (err as PodError)?.code ?? 'DB_ERROR',
            });
            await this.sleep(100);
          }
          continue;
        }

        // 4. Submit oldest QUEUED job (single flight: at most 1 generation)
        const queuedJob = activeJobs.find((j) => j.state === 'QUEUED');
        if (queuedJob) {
          try {
            await this.handleSubmit(queuedJob);
          } catch (err) {
            this.logger.error('submit_handler_error', {
              jobId: queuedJob.id,
              error: (err as PodError)?.code ?? 'PROVIDER_ERROR',
            });
            try {
              const current = this.db.jobs.getById(queuedJob.id);
              if (current?.state === 'SUBMITTING') {
                this.db.jobs.transition(current.id, 'AMBIGUOUS', {
                  errorCode: 'SUBMIT_AMBIGUOUS',
                  safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
                });
                await this.emitJobUpdated(current.id);
              } else if (current?.state === 'QUEUED') {
                this.db.jobs.transition(current.id, 'FAILED_RETRYABLE', {
                  errorCode: 'PROVIDER_ERROR',
                  safeErrorMessage: SAFE_ERROR_MESSAGES.PROVIDER_ERROR,
                });
                await this.emitJobUpdated(current.id);
              }
            } catch {
              // ignore
            }
            await this.sleep(100);
          }
          continue;
        }

        // If more work was scheduled while finishing up, check again
        if (this.hasPendingWork) {
          continue;
        }

        // No more active jobs to process
        break;
      }
    } catch (err) {
      this.logger.error('worker_loop_error', { error: String(err) });
    } finally {
      this.isProcessing = false;
      if (this.hasPendingWork && !this.stopped) {
        this.scheduleProcessQueue();
      }
    }
  }

  /**
   * Prompt snapshot for a job. Regenerated jobs created before the snapshot row was copied have none of
   * their own, so walk back through `regeneratedFromJobId` (bounded). The caller still verifies sha256.
   */
  private findPromptSnapshotAsset(job: Job): Asset | undefined {
    let current: Job | undefined = job;
    for (let depth = 0; current && depth < 10; depth++) {
      const found = this.db.assets.listByJob(current.id).find((a) => a.role === 'prompt_snapshot');
      if (found) return found;
      if (!current.regeneratedFromJobId) return undefined;
      current = this.db.jobs.getById(current.regeneratedFromJobId) ?? undefined;
    }
    return undefined;
  }

  /**
   * Interior artwork asset for a job. For regenerated jobs, walk back through `regeneratedFromJobId`
   * if needed (though regenerate inserts an interior_artwork asset for the new job).
   */
  private findInteriorArtworkAsset(job: Job): Asset | undefined {
    let current: Job | undefined = job;
    for (let depth = 0; current && depth < 10; depth++) {
      const found = this.db.assets.listByJob(current.id).find((a) => a.role === 'interior_artwork');
      if (found) return found;
      if (!current.regeneratedFromJobId) return undefined;
      current = this.db.jobs.getById(current.regeneratedFromJobId) ?? undefined;
    }
    return undefined;
  }

  /**
   * Determines if a job is a calendar job and finds its interior artwork asset.
   * A job is a calendar job if it already has an interior_artwork asset or its current category promptGroup is 'calendar'.
   */
  private jobCalendarInfo(job: Job): { isCalendar: boolean; artwork: Asset | undefined } {
    const artwork = this.db.assets.listByJob(job.id).find((a) => a.role === 'interior_artwork');
    const product = this.db.products.getById(job.productId);
    const category = this.config.categories.find((c) => c.id === product?.category);
    const isCalendar = artwork !== undefined || category?.promptGroup === 'calendar';
    return { isCalendar, artwork };
  }

  private async handleSubmit(job: Job): Promise<void> {
    // 1. Resolve source asset file BEFORE transitioning to SUBMITTING
    const sourceAsset = this.db.assets.getById(job.sourceAssetId);
    let sourceAbsPath: string | null = null;
    if (sourceAsset) {
      const p = this.media.resolve(sourceAsset.path);
      if (fs.existsSync(p)) {
        sourceAbsPath = p;
      }
    }
    if (!sourceAsset || !sourceAbsPath) {
      this.db.jobs.transition(job.id, 'FAILED_RETRYABLE', {
        errorCode: 'NOT_FOUND',
        safeErrorMessage: 'Source image asset missing',
      });
      await this.emitJobUpdated(job.id);
      return;
    }

    // 2. Resolve and verify prompt snapshot text BEFORE transitioning to SUBMITTING
    const promptAsset = this.findPromptSnapshotAsset(job);
    let promptText: string | null = null;
    if (promptAsset) {
      const promptAbsPath = this.media.resolve(promptAsset.path);
      try {
        if (fs.existsSync(promptAbsPath)) {
          promptText = fs.readFileSync(promptAbsPath, 'utf-8');
        }
      } catch {
        promptText = null;
      }
    }

    if (promptText === null || !promptAsset) {
      this.db.jobs.transition(job.id, 'FAILED_RETRYABLE', {
        errorCode: 'INVALID_PROMPT',
        safeErrorMessage: 'Prompt snapshot file unreadable or missing',
      });
      await this.emitJobUpdated(job.id);
      return;
    }

    if (promptText.trim().length === 0) {
      this.db.jobs.transition(job.id, 'FAILED_RETRYABLE', {
        errorCode: 'INVALID_PROMPT',
        safeErrorMessage: 'Prompt text is empty',
      });
      await this.emitJobUpdated(job.id);
      return;
    }

    const calculatedSha256 = crypto.createHash('sha256').update(promptText, 'utf-8').digest('hex');
    if (calculatedSha256 !== job.promptSha256) {
      this.db.jobs.transition(job.id, 'FAILED_RETRYABLE', {
        errorCode: 'INVALID_PROMPT',
        safeErrorMessage: 'Prompt snapshot hash mismatch',
      });
      await this.emitJobUpdated(job.id);
      return;
    }

    // 2b. Fit the front cover into the provider upload limit BEFORE SUBMITTING (failure => not sent).
    let upload: PreparedUploadImage;
    try {
      const caps = await this.getCapabilities();
      upload = await prepareUploadImage({
        srcPath: sourceAbsPath,
        fileName: path.basename(sourceAsset.path),
        maxBytes: caps.maxUploadBytes,
        newTempPath: () => this.media.newTempPath(),
        encoder: this.imageEncoder,
      });
    } catch (err) {
      const code = err instanceof PodError ? err.code : 'INVALID_IMAGE';
      this.db.jobs.transition(job.id, 'FAILED_RETRYABLE', {
        errorCode: code,
        safeErrorMessage: err instanceof PodError ? err.safeMessage : SAFE_ERROR_MESSAGES.INVALID_IMAGE,
      });
      this.logger.warn('source_image_prepare_failed', { jobId: job.id, sku: job.skuSnapshot, code });
      await this.emitJobUpdated(job.id);
      return;
    }
    if (upload.transcoded) {
      this.logger.info('source_image_transcoded', {
        jobId: job.id,
        sku: job.skuSnapshot,
        originalBytes: upload.originalBytes,
        uploadBytes: upload.uploadBytes,
        width: upload.width,
        height: upload.height,
        quality: upload.quality,
      });
    }

    try {
      await this.submitPrepared(job, upload, promptText);
    } finally {
      upload.cleanup();
    }
  }

  private async submitPrepared(job: Job, upload: PreparedUploadImage, promptText: string): Promise<void> {
    // 3. Persist SUBMITTING + submitIntentAt before calling provider.generateVideo
    const now = nowIso();
    const updated = this.db.jobs.transition(job.id, 'SUBMITTING', {
      submitIntentAt: now,
      attempt: job.attempt === 0 ? 1 : job.attempt,
    });
    this.logger.info('job_submitting', {
      jobId: updated.id,
      sku: updated.skuSnapshot,
    });
    await this.emitJobUpdated(updated.id);

    try {
      const res = await this.provider.generateVideo({
        sku: updated.skuSnapshot,
        sourceImagePath: upload.path,
        sourceFileName: upload.fileName,
        prompt: promptText,
        requestId: updated.idempotencyKey,
        durationSeconds: updated.durationSeconds ?? undefined,
        aspectRatio: updated.aspectRatio ?? undefined,
      });

      if (res.state === 'ambiguous') {
        this.db.jobs.transition(updated.id, 'AMBIGUOUS', {
          providerJobId: res.providerJobId || null,
          providerReferenceId: res.providerReferenceId || null,
          errorCode: 'SUBMIT_AMBIGUOUS',
          safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
        });
        this.logger.warn('job_submit_ambiguous', {
          jobId: updated.id,
          sku: updated.skuSnapshot,
        });
      } else if (res.state === 'failed') {
        const code = res.errorCode ?? 'PROVIDER_ERROR';
        if (code === 'QUOTA_LIMITED') {
          this.db.jobs.transition(updated.id, 'FAILED_QUOTA', {
            providerJobId: res.providerJobId || null,
            providerReferenceId: res.providerReferenceId || null,
            errorCode: 'QUOTA_LIMITED',
            safeErrorMessage: res.safeMessage ?? SAFE_ERROR_MESSAGES.QUOTA_LIMITED,
          });
        } else if (code === 'CONTENT_REFUSED') {
          this.db.jobs.transition(updated.id, 'FAILED_REFUSED', {
            providerJobId: res.providerJobId || null,
            providerReferenceId: res.providerReferenceId || null,
            errorCode: 'CONTENT_REFUSED',
            safeErrorMessage: res.safeMessage ?? SAFE_ERROR_MESSAGES.CONTENT_REFUSED,
          });
        } else {
          this.db.jobs.transition(updated.id, 'FAILED_PROVIDER', {
            providerJobId: res.providerJobId || null,
            providerReferenceId: res.providerReferenceId || null,
            errorCode: code,
            safeErrorMessage: res.safeMessage ?? SAFE_ERROR_MESSAGES.PROVIDER_ERROR,
          });
        }
      } else {
        // Confirmed acceptance: running or queued
        this.pollAttempt = 0;
        this.db.jobs.transition(updated.id, 'RUNNING', {
          providerJobId: res.providerJobId,
          providerReferenceId: res.providerReferenceId ?? null,
          acceptedAt: nowIso(),
        });
        this.logger.info('job_running', {
          jobId: updated.id,
          sku: updated.skuSnapshot,
        });
      }
      await this.emitJobUpdated(updated.id);
    } catch (err: unknown) {
      if (err instanceof ProviderError) {
        if (err.code === 'QUOTA_LIMITED') {
          this.db.jobs.transition(updated.id, 'FAILED_QUOTA', {
            errorCode: 'QUOTA_LIMITED',
            safeErrorMessage: err.safeMessage,
          });
        } else if (err.code === 'CONTENT_REFUSED') {
          this.db.jobs.transition(updated.id, 'FAILED_REFUSED', {
            errorCode: 'CONTENT_REFUSED',
            safeErrorMessage: err.safeMessage,
          });
        } else if (err.phase === 'before_submit') {
          this.db.jobs.transition(updated.id, 'FAILED_RETRYABLE', {
            errorCode: err.code,
            safeErrorMessage: err.safeMessage,
          });
        } else {
          // after_submit or unknown -> AMBIGUOUS (never automatic resubmit)
          this.db.jobs.transition(updated.id, 'AMBIGUOUS', {
            errorCode: 'SUBMIT_AMBIGUOUS',
            safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
          });
        }
      } else {
        this.db.jobs.transition(updated.id, 'AMBIGUOUS', {
          errorCode: 'SUBMIT_AMBIGUOUS',
          safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
        });
      }
      await this.emitJobUpdated(updated.id);
    }
  }

  private async handleRunning(job: Job): Promise<void> {
    if (!job.providerJobId) {
      this.db.jobs.transition(job.id, 'AMBIGUOUS', {
        errorCode: 'SUBMIT_AMBIGUOUS',
        safeErrorMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
      });
      await this.emitJobUpdated(job.id);
      return;
    }

    try {
      const providerJob = await this.provider.getJob(job.providerJobId);

      // Clear any prior transient connection error note on successful poll
      if (job.safeErrorMessage) {
        this.db.jobs.update(job.id, {
          safeErrorMessage: null,
          errorCode: null,
        });
        job.safeErrorMessage = null;
        job.errorCode = null;
      }

      if (typeof providerJob.progress === 'number') {
        this.jobProgress.set(job.id, providerJob.progress);
        await this.emitJobUpdated(job.id);
      }

      if (providerJob.state === 'running' || providerJob.state === 'queued') {
        const delay = nextPollDelay(
          this.pollAttempt,
          this.config.pollIntervalMs,
          this.config.pollMaxIntervalMs
        );
        this.pollAttempt++;
        await this.sleep(delay);
        return;
      }

      this.pollAttempt = 0;
      this.jobProgress.delete(job.id);

      if (providerJob.state === 'succeeded') {
        this.db.jobs.transition(job.id, 'DOWNLOADING', {
          providerAssetId: providerJob.providerAssetId ?? null,
        });
        this.logger.info('job_generating_completed', {
          jobId: job.id,
          sku: job.skuSnapshot,
        });
        await this.emitJobUpdated(job.id);
      } else if (providerJob.state === 'failed') {
        const code = providerJob.errorCode ?? 'PROVIDER_ERROR';
        if (code === 'QUOTA_LIMITED') {
          this.db.jobs.transition(job.id, 'FAILED_QUOTA', {
            errorCode: 'QUOTA_LIMITED',
            safeErrorMessage: providerJob.safeMessage ?? SAFE_ERROR_MESSAGES.QUOTA_LIMITED,
          });
        } else if (code === 'CONTENT_REFUSED') {
          this.db.jobs.transition(job.id, 'FAILED_REFUSED', {
            errorCode: 'CONTENT_REFUSED',
            safeErrorMessage: providerJob.safeMessage ?? SAFE_ERROR_MESSAGES.CONTENT_REFUSED,
          });
        } else {
          this.db.jobs.transition(job.id, 'FAILED_PROVIDER', {
            errorCode: code,
            safeErrorMessage: providerJob.safeMessage ?? SAFE_ERROR_MESSAGES.PROVIDER_ERROR,
          });
        }
        await this.emitJobUpdated(job.id);
      } else if (providerJob.state === 'cancelled') {
        this.db.jobs.transition(job.id, 'CANCELLED');
        await this.emitJobUpdated(job.id);
      } else {
        // 'ambiguous' (e.g. Muse4AI needs_review) or any state we cannot interpret: stop polling and let a
        // person check — never resubmit.
        this.db.jobs.transition(job.id, 'AMBIGUOUS', {
          errorCode: providerJob.errorCode ?? 'SUBMIT_AMBIGUOUS',
          safeErrorMessage: providerJob.safeMessage ?? SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
        });
        this.logger.warn('job_poll_ambiguous', { jobId: job.id, sku: job.skuSnapshot });
        await this.emitJobUpdated(job.id);
      }
    } catch (err: unknown) {
      if (err instanceof ProviderError) {
        if (err.code === 'QUOTA_LIMITED') {
          this.pollAttempt = 0;
          this.jobProgress.delete(job.id);
          this.db.jobs.transition(job.id, 'FAILED_QUOTA', {
            errorCode: 'QUOTA_LIMITED',
            safeErrorMessage: err.safeMessage,
          });
          await this.emitJobUpdated(job.id);
          return;
        }
        if (err.code === 'CONTENT_REFUSED') {
          this.pollAttempt = 0;
          this.jobProgress.delete(job.id);
          this.db.jobs.transition(job.id, 'FAILED_REFUSED', {
            errorCode: 'CONTENT_REFUSED',
            safeErrorMessage: err.safeMessage,
          });
          await this.emitJobUpdated(job.id);
          return;
        }
        if (err.code === 'NOT_FOUND' || (err as { statusCode?: number }).statusCode === 404) {
          this.pollAttempt = 0;
          this.jobProgress.delete(job.id);
          this.db.jobs.transition(job.id, 'AMBIGUOUS', {
            errorCode: 'NOT_FOUND',
            safeErrorMessage: 'Provider job not found during polling — state ambiguous',
          });
          await this.emitJobUpdated(job.id);
          return;
        }
      }

      // Transient polling error (bridge down, timeout, 5xx, network drop, etc.):
      // Keep the job RUNNING, record a safe note, and back off
      const note = 'Connection to the Muse bridge lost — still checking';
      this.db.jobs.update(job.id, {
        safeErrorMessage: note,
      });
      job.safeErrorMessage = note;
      await this.emitJobUpdated(job.id);

      const delay = nextPollDelay(
        this.pollAttempt,
        this.config.pollIntervalMs,
        this.config.pollMaxIntervalMs
      );
      this.pollAttempt++;
      await this.sleep(delay);
    }
  }

  private async handleDownloading(job: Job): Promise<void> {
    if (!job.providerJobId) {
      this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
        errorCode: 'DOWNLOAD_FAILED',
        safeErrorMessage: 'Missing provider job ID for download',
      });
      await this.emitJobUpdated(job.id);
      return;
    }

    const tempPartPath = this.media.newTempPath();
    let processedTempPath: string | null = null;

    try {
      // 1. Download output to temp file
      try {
        await this.provider.downloadOutput(job.providerJobId, tempPartPath, this.config.maxVideoBytes);
      } catch (err: unknown) {
        const code = err instanceof ProviderError ? err.code : 'DOWNLOAD_FAILED';
        const safeMessage = err instanceof PodError ? err.safeMessage : SAFE_ERROR_MESSAGES.DOWNLOAD_FAILED;
        this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
          errorCode: code,
          safeErrorMessage: safeMessage,
        });
        this.logger.error('job_download_failed', {
          jobId: job.id,
          sku: job.skuSnapshot,
          code,
        });
        await this.emitJobUpdated(job.id);
        return;
      }

      // Check calendar post-processing (artwork asset present or category is calendar)
      const { isCalendar, artwork: artworkAsset } = this.jobCalendarInfo(job);

      let videoFileToStore = tempPartPath;
      let compositionReport: CalendarCompositionReport | null = null;

      if (isCalendar) {
        if (!artworkAsset) {
          this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
            errorCode: 'NOT_FOUND',
            safeErrorMessage: SAFE_ERROR_MESSAGES.NOT_FOUND,
          });
          this.logger.error('calendar_artwork_asset_missing', {
            jobId: job.id,
            sku: job.skuSnapshot,
          });
          await this.emitJobUpdated(job.id);
          return;
        }

        let artworkAbsPath: string;
        try {
          artworkAbsPath = this.media.resolve(artworkAsset.path);
        } catch {
          this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
            errorCode: 'NOT_FOUND',
            safeErrorMessage: SAFE_ERROR_MESSAGES.NOT_FOUND,
          });
          await this.emitJobUpdated(job.id);
          return;
        }

        if (!fs.existsSync(artworkAbsPath)) {
          this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
            errorCode: 'NOT_FOUND',
            safeErrorMessage: SAFE_ERROR_MESSAGES.NOT_FOUND,
          });
          this.logger.error('calendar_artwork_file_missing', {
            jobId: job.id,
            sku: job.skuSnapshot,
          });
          await this.emitJobUpdated(job.id);
          return;
        }

        const calculatedSha256 = await hashFile(artworkAbsPath);
        if (calculatedSha256 !== artworkAsset.sha256) {
          this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
            errorCode: 'CALENDAR_COMPOSITING_FAILED',
            safeErrorMessage: SAFE_ERROR_MESSAGES.CALENDAR_COMPOSITING_FAILED,
          });
          this.logger.error('calendar_artwork_hash_mismatch', {
            jobId: job.id,
            sku: job.skuSnapshot,
          });
          await this.emitJobUpdated(job.id);
          return;
        }

        processedTempPath = this.media.newTempPath();

        try {
          compositionReport = await this.compositor.process({
            inputVideoPath: tempPartPath,
            artworkPath: artworkAbsPath,
            outputVideoPath: processedTempPath,
            sku: job.skuSnapshot,
            jobId: job.id,
          });
        } catch (err: unknown) {
          const code = 'CALENDAR_COMPOSITING_FAILED';
          const safeMessage =
            err instanceof PodError ? err.safeMessage : SAFE_ERROR_MESSAGES.CALENDAR_COMPOSITING_FAILED;
          this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
            errorCode: code,
            safeErrorMessage: safeMessage,
          });
          this.logger.error('job_compositor_failed', {
            jobId: job.id,
            sku: job.skuSnapshot,
            code,
          });
          await this.emitJobUpdated(job.id);
          return;
        }

        videoFileToStore = processedTempPath;
      }

      // 2. Validate and store video in SKU folder
      let storedVideo: StoredFile;
      try {
        storedVideo = await this.media.storeVideo(videoFileToStore, job.skuSnapshot);
      } catch (err: unknown) {
        const code = err instanceof PodError ? err.code : 'DOWNLOAD_FAILED';
        const safeMessage = err instanceof PodError ? err.safeMessage : SAFE_ERROR_MESSAGES.DOWNLOAD_FAILED;
        this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
          errorCode: code,
          safeErrorMessage: safeMessage,
        });
        this.logger.error('job_store_video_failed', {
          jobId: job.id,
          sku: job.skuSnapshot,
          code,
        });
        await this.emitJobUpdated(job.id);
        return;
      }

      // 3. Write sanitized metadata json (no prompt text, no absolute paths)
      const baseName = path.parse(storedVideo.relPath).name;
      const completedAt = nowIso();
      const metadata: Record<string, unknown> = {
        jobId: job.id,
        productId: job.productId,
        sku: job.skuSnapshot,
        provider: job.provider,
        providerJobId: job.providerJobId,
        providerAssetId: job.providerAssetId,
        templateId: job.promptTemplateId,
        templateVersion: job.promptTemplateVersion,
        promptSha256: job.promptSha256,
        videoSha256: storedVideo.sha256,
        videoBytes: storedVideo.bytes,
        createdAt: job.createdAt,
        completedAt,
        ...(compositionReport
          ? {
              calendarPostProcess: {
                applied: compositionReport.applied,
                interiorArtworkSha256: compositionReport.artworkSha256,
                compositorVersion: compositionReport.compositorVersion,
                trackingCoverage: compositionReport.trackingCoverage,
                processedFrames: compositionReport.processedFrames,
                visibleFrames: compositionReport.visibleFrames,
                lowConfidenceFrames: compositionReport.lowConfidenceFrames,
              },
            }
          : {}),
      };
      try {
        await this.media.writeMetadata(job.skuSnapshot, baseName, metadata);
      } catch (err) {
        this.logger.warn('metadata_write_failed', {
          jobId: job.id,
          sku: job.skuSnapshot,
          error: (err as PodError)?.code ?? 'IO_ERROR',
        });
        // Non-critical: continue to SUCCEEDED
      }

      // 4. In a sync transaction: insert generated_video asset and set SUCCEEDED
      try {
        this.db.transaction(() => {
          this.db.assets.insert({
            productId: job.productId,
            jobId: job.id,
            role: 'generated_video',
            path: storedVideo.relPath,
            mime: 'video/mp4',
            bytes: storedVideo.bytes,
            width: storedVideo.width,
            height: storedVideo.height,
            durationMs: null,
            sha256: storedVideo.sha256,
          });
          this.db.jobs.transition(job.id, 'SUCCEEDED', {
            completedAt,
          });
        });
      } catch (err) {
        // Transaction failed: delete stored file and move to DOWNLOAD_FAILED
        try {
          if (fs.existsSync(storedVideo.absPath)) {
            fs.unlinkSync(storedVideo.absPath);
          }
        } catch {
          // ignore
        }
        this.db.jobs.transition(job.id, 'DOWNLOAD_FAILED', {
          errorCode: 'DOWNLOAD_FAILED',
          safeErrorMessage: SAFE_ERROR_MESSAGES.DOWNLOAD_FAILED,
        });
        this.logger.error('job_asset_insert_failed', {
          jobId: job.id,
          sku: job.skuSnapshot,
          error: (err as PodError)?.code ?? 'DB_ERROR',
        });
        await this.emitJobUpdated(job.id);
        return;
      }

      const elapsed = Math.max(0, new Date(completedAt).getTime() - new Date(job.createdAt).getTime());
      this.logger.info('job_succeeded', {
        jobId: job.id,
        sku: job.skuSnapshot,
        durationMs: elapsed,
      });
      await this.emitJobUpdated(job.id);
    } finally {
      try {
        if (fs.existsSync(tempPartPath)) fs.unlinkSync(tempPartPath);
      } catch {
        // ignore
      }
      if (processedTempPath) {
        try {
          if (fs.existsSync(processedTempPath)) fs.unlinkSync(processedTempPath);
        } catch {
          // ignore
        }
      }
    }
  }

  private async emitJobUpdated(jobId: string): Promise<void> {
    const job = this.db.jobs.getById(jobId);
    if (job) {
      const view = await this.toJobView(job);
      this.emit('job:updated', view);
    }
  }

  async toJobView(job: Job, capsOverride?: ProviderCapabilities): Promise<JobView> {
    const caps = capsOverride ?? (await this.getCapabilities());
    const product = this.db.products.getById(job.productId);
    const assets = this.db.assets.listByJob(job.id);
    const sourceAsset = this.db.assets.getById(job.sourceAssetId);
    const videoAsset = assets.find((a) => a.role === 'generated_video');
    const artworkAsset = assets.find((a) => a.role === 'interior_artwork');

    let elapsedMs: number;
    if (isTerminal(job.state)) {
      if (job.completedAt) {
        elapsedMs = Math.max(0, new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime());
      } else {
        elapsedMs = Math.max(0, new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime());
      }
    } else {
      elapsedMs = Math.max(0, Date.now() - new Date(job.createdAt).getTime());
    }

    return {
      job,
      stateLabel: JOB_STATE_LABELS[job.state],
      category: product?.category ?? '',
      productName: product?.productName ?? null,
      sourceUrl: sourceAsset ? `pod-media://asset/${sourceAsset.id}` : null,
      videoUrl: videoAsset ? `pod-media://asset/${videoAsset.id}` : null,
      videoAssetId: videoAsset?.id ?? null,
      interiorArtworkUrl: artworkAsset ? `pod-media://asset/${artworkAsset.id}` : null,
      elapsedMs,
      progress: this.jobProgress.get(job.id) ?? null,
      nextActions: nextActionsFor(job, caps),
    };
  }

  private toJobViewSync(job: Job): JobView {
    const product = this.db.products.getById(job.productId);
    const assets = this.db.assets.listByJob(job.id);
    const sourceAsset = this.db.assets.getById(job.sourceAssetId);
    const videoAsset = assets.find((a) => a.role === 'generated_video');
    const artworkAsset = assets.find((a) => a.role === 'interior_artwork');

    let elapsedMs: number;
    if (isTerminal(job.state)) {
      if (job.completedAt) {
        elapsedMs = Math.max(0, new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime());
      } else {
        elapsedMs = Math.max(0, new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime());
      }
    } else {
      elapsedMs = Math.max(0, Date.now() - new Date(job.createdAt).getTime());
    }

    return {
      job,
      stateLabel: JOB_STATE_LABELS[job.state],
      category: product?.category ?? '',
      productName: product?.productName ?? null,
      sourceUrl: sourceAsset ? `pod-media://asset/${sourceAsset.id}` : null,
      videoUrl: videoAsset ? `pod-media://asset/${videoAsset.id}` : null,
      videoAssetId: videoAsset?.id ?? null,
      interiorArtworkUrl: artworkAsset ? `pod-media://asset/${artworkAsset.id}` : null,
      elapsedMs,
      progress: this.jobProgress.get(job.id) ?? null,
      nextActions: nextActionsFor(job, null),
    };
  }
}
