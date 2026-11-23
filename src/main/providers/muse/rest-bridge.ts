/**
 * RestBridgeMuseProvider: typed REST client for the approved local Muse bridge.
 * Enforces loopback-only communication, idempotency, ambiguous-submit safety,
 * download size caps, and strict privacy controls (no secret or prompt logging).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DownloadResult,
  GenerateVideoInput,
  MuseProvider,
  ProviderCapabilities,
  ProviderConnectionState,
  ProviderJob,
} from '@shared/provider';
import { ProviderError } from '@shared/provider';
import type { ProviderFactoryDeps, Logger } from '@shared/services';
import { SAFE_ERROR_MESSAGES } from '@shared/errors';
import {
  assetDownloadEndpoint,
  BridgeErrorResponseSchema,
  HEALTH_ENDPOINT,
  jobCancelEndpoint,
  jobEndpoint,
  JOBS_ENDPOINT,
  JobStatusResponseSchema,
  JobSubmitResponseSchema,
  REFERENCES_ENDPOINT,
  ReferenceUploadResponseSchema,
  STATUS_ENDPOINT,
  StatusResponseSchema,
} from './endpoints';
import { streamDownloadToFile, validateLoopbackUrl, validateSameOrigin } from './http';
import {
  DEFAULT_CAPABILITIES,
  mapBridgeCapabilities,
  mapBridgeConnectionState,
  mapBridgeJobState,
} from './mapping';

const DEFAULT_CAPABILITIES_CACHE_TTL_MS = 60_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 15_000;
const DEFAULT_STANDARD_REQUEST_TIMEOUT_MS = 5_000;

export interface RestBridgeOptions {
  submitTimeoutMs?: number;
  standardTimeoutMs?: number;
}

export class RestBridgeMuseProvider implements MuseProvider {
  readonly kind = 'bridge' as const;
  private readonly config: ProviderFactoryDeps['config'];
  private readonly getApiKey: ProviderFactoryDeps['getApiKey'];
  private readonly logger: Logger;
  private readonly validatedBaseUrl: URL | null = null;
  private readonly submitTimeoutMs: number;
  private readonly standardTimeoutMs: number;

  private cachedCapabilities: ProviderCapabilities | null = null;
  private capabilitiesCachedAt = 0;
  private canLookupByRequestId = false;

  constructor(deps: ProviderFactoryDeps, options: RestBridgeOptions = {}) {
    this.config = deps.config;
    this.getApiKey = deps.getApiKey;
    this.logger = deps.logger;
    this.submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
    this.standardTimeoutMs = options.standardTimeoutMs ?? DEFAULT_STANDARD_REQUEST_TIMEOUT_MS;

    if (this.config.bridgeBaseUrl) {
      // Rejects non-loopback hosts and invalid schemes immediately at construction
      this.validatedBaseUrl = validateLoopbackUrl(this.config.bridgeBaseUrl);
    }
  }

  private getBaseUrl(): URL {
    if (this.validatedBaseUrl) {
      return this.validatedBaseUrl;
    }
    return validateLoopbackUrl(this.config.bridgeBaseUrl);
  }

  async getConnectionState(): Promise<ProviderConnectionState> {
    const startTime = Date.now();
    let baseUrl: URL;
    try {
      baseUrl = this.getBaseUrl();
    } catch {
      return 'not_installed';
    }

    // 1. Health check (unauthenticated)
    const healthUrl = new URL(HEALTH_ENDPOINT, baseUrl).toString();
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.standardTimeoutMs),
      });

      if (!res.ok) {
        this.logger.warn('muse.health_check_failed', {
          statusCode: res.status,
          durationMs: Date.now() - startTime,
        });
        return 'error';
      }
    } catch {
      this.logger.debug('muse.health_unreachable', {
        durationMs: Date.now() - startTime,
      });
      return 'not_installed';
    }

    // 2. Status check (authenticated)
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return 'needs_login';
    }

    const statusUrl = new URL(STATUS_ENDPOINT, baseUrl).toString();
    try {
      const res = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.standardTimeoutMs),
      });

      if (res.status === 401 || res.status === 403) {
        this.logger.warn('muse.status_unauthorized', {
          statusCode: res.status,
          durationMs: Date.now() - startTime,
        });
        return 'error';
      }

      if (!res.ok) {
        this.logger.warn('muse.status_error', {
          statusCode: res.status,
          durationMs: Date.now() - startTime,
        });
        return 'error';
      }

      const json = await res.json();
      const parseResult = StatusResponseSchema.safeParse(json);
      if (!parseResult.success) {
        this.logger.warn('muse.status_parse_error', {
          durationMs: Date.now() - startTime,
        });
        return 'error';
      }

      const state = mapBridgeConnectionState(parseResult.data);
      this.logger.info('muse.status_checked', {
        state,
        durationMs: Date.now() - startTime,
      });

      // Update capabilities cache if present in status response
      if (parseResult.data.capabilities) {
        this.cachedCapabilities = mapBridgeCapabilities(parseResult.data.capabilities);
        this.capabilitiesCachedAt = Date.now();
        this.canLookupByRequestId =
          parseResult.data.capabilities.can_lookup_by_request_id ??
          parseResult.data.capabilities.canLookupByRequestId ??
          false;
      }

      return state;
    } catch {
      this.logger.warn('muse.status_request_failed', {
        durationMs: Date.now() - startTime,
      });
      return 'error';
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    const now = Date.now();
    if (this.cachedCapabilities && now - this.capabilitiesCachedAt < DEFAULT_CAPABILITIES_CACHE_TTL_MS) {
      return this.cachedCapabilities;
    }

    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return { ...DEFAULT_CAPABILITIES };
    }

    const statusUrl = new URL(STATUS_ENDPOINT, baseUrl).toString();
    try {
      const res = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.standardTimeoutMs),
      });

      if (res.ok) {
        const json = await res.json();
        const parseResult = StatusResponseSchema.safeParse(json);
        if (parseResult.success && parseResult.data.capabilities) {
          this.cachedCapabilities = mapBridgeCapabilities(parseResult.data.capabilities);
          this.capabilitiesCachedAt = Date.now();
          this.canLookupByRequestId =
            parseResult.data.capabilities.can_lookup_by_request_id ??
            parseResult.data.capabilities.canLookupByRequestId ??
            false;
          return this.cachedCapabilities;
        }
      }
    } catch {
      // Fallback to conservative defaults
    }

    return { ...DEFAULT_CAPABILITIES };
  }

  async generateVideo(input: GenerateVideoInput): Promise<ProviderJob> {
    const capabilities = await this.getCapabilities();

    // 1. Pre-checks (phase: 'before_submit')
    if (!input.prompt || input.prompt.trim().length === 0) {
      throw new ProviderError('INVALID_PROMPT', 'before_submit', 'Prompt cannot be empty.');
    }
    if (input.prompt.length > capabilities.maxPromptChars) {
      throw new ProviderError(
        'PROMPT_TOO_LONG',
        'before_submit',
        `Prompt length (${input.prompt.length}) exceeds maximum limit (${capabilities.maxPromptChars}).`
      );
    }

    if (!fs.existsSync(input.sourceImagePath)) {
      throw new ProviderError('INVALID_IMAGE', 'before_submit', 'Source image file does not exist.');
    }

    const fileStat = fs.statSync(input.sourceImagePath);
    if (fileStat.size <= 0) {
      throw new ProviderError('INVALID_IMAGE', 'before_submit', 'Source image file is empty.');
    }
    if (fileStat.size > capabilities.maxUploadBytes) {
      throw new ProviderError(
        'IMAGE_TOO_LARGE',
        'before_submit',
        `Source image size (${fileStat.size} bytes) exceeds upload limit (${capabilities.maxUploadBytes} bytes).`
      );
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ProviderError('NEEDS_LOGIN', 'before_submit', 'API key is missing.');
    }

    const baseUrl = this.getBaseUrl();

    // 2. Upload source reference image (failures here are 'before_submit')
    const referenceId = await this.uploadReference(input, baseUrl, apiKey);

    // 3. Submit video generation job (single attempt, never auto-resubmit)
    return this.submitJob(input, referenceId, baseUrl, apiKey);
  }

  private async uploadReference(
    input: GenerateVideoInput,
    baseUrl: URL,
    apiKey: string
  ): Promise<string> {
    const startTime = Date.now();
    const referencesUrl = new URL(REFERENCES_ENDPOINT, baseUrl).toString();

    let imageBuffer: Buffer;
    try {
      imageBuffer = fs.readFileSync(input.sourceImagePath);
    } catch (err) {
      throw new ProviderError('INVALID_IMAGE', 'before_submit', 'Failed to read source image.', {
        cause: err,
      });
    }

    const mime = detectImageMime(imageBuffer, input.sourceImagePath);
    const safeFileName = path.basename(input.sourceFileName);

    try {
      const res = await fetch(referencesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': mime,
          'X-File-Name': safeFileName,
        },
        body: imageBuffer,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.submitTimeoutMs),
      });

      if (!res.ok) {
        this.logger.warn('muse.upload_reference_failed', {
          statusCode: res.status,
          durationMs: Date.now() - startTime,
        });

        if (res.status === 401 || res.status === 403) {
          throw new ProviderError('NEEDS_LOGIN', 'before_submit');
        }
        if (res.status === 413) {
          throw new ProviderError('IMAGE_TOO_LARGE', 'before_submit');
        }
        throw new ProviderError(
          'PROVIDER_ERROR',
          'before_submit',
          `Reference upload failed with status ${res.status}.`
        );
      }

      const json = await res.json();
      const parseResult = ReferenceUploadResponseSchema.safeParse(json);
      const referenceId = parseResult.success
        ? parseResult.data.reference_id ?? parseResult.data.id
        : undefined;
      if (!referenceId || typeof referenceId !== 'string') {
        throw new ProviderError(
          'PROVIDER_ERROR',
          'before_submit',
          'Provider response did not contain a valid reference ID.'
        );
      }

      this.logger.info('muse.upload_reference_success', {
        durationMs: Date.now() - startTime,
      });

      return referenceId;
    } catch (err) {
      if (err instanceof ProviderError) {
        throw err;
      }
      this.logger.warn('muse.upload_reference_network_error', {
        durationMs: Date.now() - startTime,
      });
      throw new ProviderError('NOT_CONNECTED', 'before_submit', 'Failed to reach bridge for upload.', {
        cause: err,
      });
    }
  }

  private async submitJob(
    input: GenerateVideoInput,
    referenceId: string,
    baseUrl: URL,
    apiKey: string
  ): Promise<ProviderJob> {
    const startTime = Date.now();
    const jobsUrl = new URL(JOBS_ENDPOINT, baseUrl).toString();

    const requestPayload: Record<string, unknown> = {
      kind: 'video',
      mode: 'reference',
      prompt: input.prompt,
      reference_id: referenceId,
      repeat: 1,
      account: 'auto',
    };

    if (input.durationSeconds) {
      requestPayload['duration'] = input.durationSeconds;
    }
    if (input.aspectRatio) {
      requestPayload['aspect_ratio'] = input.aspectRatio;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.submitTimeoutMs);

    let res: Response;
    try {
      res = await fetch(jobsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.requestId,
        },
        body: JSON.stringify(requestPayload),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      // Check if error is before any byte was sent (connection refused or DNS error)
      const errorObj = err as { code?: string; cause?: { code?: string } };
      const errorCode = errorObj.code ?? errorObj.cause?.code;

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND') {
        this.logger.warn('muse.submit_connection_refused', {
          requestId: input.requestId,
          durationMs: Date.now() - startTime,
        });
        throw new ProviderError('NOT_CONNECTED', 'before_submit', 'Bridge connection was refused.', {
          cause: err,
        });
      }

      // Timeout, connection reset, or socket error after send -> AMBIGUOUS
      this.logger.warn('muse.submit_ambiguous_network_error', {
        requestId: input.requestId,
        durationMs: Date.now() - startTime,
      });
      return {
        providerJobId: '',
        state: 'ambiguous',
        errorCode: 'SUBMIT_AMBIGUOUS',
        safeMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
      };
    }

    clearTimeout(timeoutId);

    // 5xx on submit -> AMBIGUOUS (never resend)
    if (res.status >= 500 && res.status <= 599) {
      this.logger.warn('muse.submit_server_5xx_ambiguous', {
        requestId: input.requestId,
        statusCode: res.status,
        durationMs: Date.now() - startTime,
      });
      return {
        providerJobId: '',
        state: 'ambiguous',
        errorCode: 'SUBMIT_AMBIGUOUS',
        safeMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
      };
    }

    // 4xx handling (Refusal, Quota, Login)
    if (res.status >= 400 && res.status < 500) {
      let isSubmitted = false;
      try {
        const errorJson = await res.json();
        const parsedError = BridgeErrorResponseSchema.safeParse(errorJson);
        if (parsedError.success && parsedError.data.submitted === true) {
          isSubmitted = true;
        }
      } catch {
        // Ignored
      }

      const phase = isSubmitted ? 'after_submit' : 'before_submit';

      this.logger.warn('muse.submit_client_error', {
        requestId: input.requestId,
        statusCode: res.status,
        durationMs: Date.now() - startTime,
      });

      if (res.status === 401) {
        throw new ProviderError('NEEDS_LOGIN', phase);
      }
      if (res.status === 403 || res.status === 422) {
        throw new ProviderError('CONTENT_REFUSED', phase);
      }
      if (res.status === 429) {
        throw new ProviderError('QUOTA_LIMITED', phase);
      }
      throw new ProviderError('PROVIDER_ERROR', phase, `Job submission failed with status ${res.status}.`);
    }

    // 200 or 202 Success response
    try {
      const json = await res.json();
      const parseResult = JobSubmitResponseSchema.safeParse(json);
      if (!parseResult.success) {
        // Unparsable 2xx -> AMBIGUOUS
        this.logger.warn('muse.submit_unparsable_2xx_ambiguous', {
          requestId: input.requestId,
          durationMs: Date.now() - startTime,
        });
        return {
          providerJobId: '',
          state: 'ambiguous',
          errorCode: 'SUBMIT_AMBIGUOUS',
          safeMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
        };
      }

      const data = parseResult.data;
      const jobId = data.id ?? data.job_id ?? data.jobs?.[0]?.id ?? data.jobs?.[0]?.job_id;

      if (!jobId || typeof jobId !== 'string') {
        this.logger.warn('muse.submit_missing_job_id_ambiguous', {
          requestId: input.requestId,
          durationMs: Date.now() - startTime,
        });
        return {
          providerJobId: '',
          state: 'ambiguous',
          errorCode: 'SUBMIT_AMBIGUOUS',
          safeMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
        };
      }

      const state = data.state ? mapBridgeJobState(data.state) : 'queued';

      this.logger.info('muse.submit_success', {
        requestId: input.requestId,
        providerJobId: jobId,
        durationMs: Date.now() - startTime,
      });

      return {
        providerJobId: jobId,
        state,
        providerReferenceId: referenceId,
      };
    } catch {
      // Unparsable JSON on 2xx -> AMBIGUOUS
      this.logger.warn('muse.submit_json_parse_error_ambiguous', {
        requestId: input.requestId,
        durationMs: Date.now() - startTime,
      });
      return {
        providerJobId: '',
        state: 'ambiguous',
        errorCode: 'SUBMIT_AMBIGUOUS',
        safeMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
      };
    }
  }

  async getJob(providerJobId: string): Promise<ProviderJob> {
    const startTime = Date.now();
    if (!/^[a-zA-Z0-9_\-.:]+$/.test(providerJobId)) {
      throw new ProviderError('NOT_FOUND', 'after_submit', 'Invalid provider job ID format.');
    }

    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ProviderError('NEEDS_LOGIN', 'before_submit');
    }

    const url = new URL(jobEndpoint(providerJobId), baseUrl).toString();

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.standardTimeoutMs),
    });

    if (res.status === 404) {
      throw new ProviderError('NOT_FOUND', 'after_submit', `Job ${providerJobId} not found.`);
    }

    if (!res.ok) {
      this.logger.warn('muse.get_job_failed', {
        providerJobId,
        statusCode: res.status,
        durationMs: Date.now() - startTime,
      });
      throw new ProviderError('PROVIDER_ERROR', 'after_submit', `Failed to query job ${providerJobId}.`);
    }

    const json = await res.json();
    const parseResult = JobStatusResponseSchema.safeParse(json);
    if (!parseResult.success) {
      throw new ProviderError('PROVIDER_ERROR', 'after_submit', 'Invalid job status payload from bridge.');
    }

    const data = parseResult.data;
    const state = mapBridgeJobState(data.state);

    const jobResult: ProviderJob = {
      providerJobId,
      state,
      providerReferenceId: data.reference_id ?? undefined,
      providerAssetId: data.asset_id ?? undefined,
    };

    if (typeof data.progress === 'number' && data.progress >= 0 && data.progress <= 1) {
      jobResult.progress = data.progress;
    }

    if (state === 'failed') {
      jobResult.errorCode = 'PROVIDER_ERROR';
      jobResult.safeMessage = SAFE_ERROR_MESSAGES.PROVIDER_ERROR;
    }

    this.logger.debug('muse.get_job_success', {
      providerJobId,
      state,
      durationMs: Date.now() - startTime,
    });

    return jobResult;
  }

  async findJobByRequestId(requestId: string): Promise<ProviderJob | null> {
    if (!this.canLookupByRequestId) {
      throw new ProviderError(
        'SUBMIT_AMBIGUOUS',
        'unknown',
        'Provider bridge does not support lookup by requestId.'
      );
    }

    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ProviderError('NEEDS_LOGIN', 'before_submit');
    }

    const url = new URL(`${JOBS_ENDPOINT}?idempotency_key=${encodeURIComponent(requestId)}`, baseUrl).toString();

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.standardTimeoutMs),
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        throw new ProviderError('PROVIDER_ERROR', 'unknown');
      }

      const json = await res.json();
      if (!json || (Array.isArray(json) && json.length === 0)) {
        return null;
      }

      const rawJob = Array.isArray(json) ? json[0] : json;
      const parsed = JobStatusResponseSchema.safeParse(rawJob);
      if (!parsed.success) return null;

      const jobId = parsed.data.id ?? parsed.data.job_id ?? '';
      return {
        providerJobId: jobId,
        state: mapBridgeJobState(parsed.data.state),
        providerAssetId: parsed.data.asset_id ?? undefined,
        providerReferenceId: parsed.data.reference_id ?? undefined,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('SUBMIT_AMBIGUOUS', 'unknown', 'Failed to lookup job by requestId.', {
        cause: err,
      });
    }
  }

  async downloadOutput(
    providerJobId: string,
    destPath: string,
    maxBytes: number
  ): Promise<DownloadResult> {
    const startTime = Date.now();
    const job = await this.getJob(providerJobId);

    if (job.state !== 'succeeded') {
      throw new ProviderError('OUTPUT_MISSING', 'after_submit', 'Job has not succeeded.');
    }

    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();

    let downloadUrl: string;
    if (job.providerAssetId) {
      downloadUrl = new URL(assetDownloadEndpoint(job.providerAssetId), baseUrl).toString();
    } else {
      throw new ProviderError('OUTPUT_MISSING', 'after_submit', 'Job has no asset ID.');
    }

    // Validate origin matches bridge origin
    validateSameOrigin(downloadUrl, baseUrl.origin);

    const bytes = await streamDownloadToFile({
      url: downloadUrl,
      destPath,
      maxBytes,
      apiKey,
    });

    this.logger.info('muse.download_success', {
      providerJobId,
      bytes,
      durationMs: Date.now() - startTime,
    });

    return { bytes };
  }

  async cancelJob(providerJobId: string): Promise<void> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.canCancel) {
      throw new ProviderError('INVALID_STATE', 'before_submit', 'Cancellation is not supported.');
    }

    if (!/^[a-zA-Z0-9_\-.:]+$/.test(providerJobId)) {
      throw new ProviderError('NOT_FOUND', 'after_submit');
    }

    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ProviderError('NEEDS_LOGIN', 'before_submit');
    }

    const url = new URL(jobCancelEndpoint(providerJobId), baseUrl).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.standardTimeoutMs),
    });

    if (!res.ok) {
      throw new ProviderError('PROVIDER_ERROR', 'after_submit', `Failed to cancel job ${providerJobId}.`);
    }
  }
}

function detectImageMime(buffer: Buffer, filePath: string): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}
