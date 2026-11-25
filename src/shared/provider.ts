/** Provider boundary, brief §3.3. The UI and app layer depend ONLY on this, never on bridge endpoints. */
import { PodError, type ErrorCode } from './errors';

/** Error thrown by MuseProvider implementations. `phase` decides whether a retry is ever allowed. */
export class ProviderError extends PodError {
  readonly phase: FailurePhase;
  constructor(code: ErrorCode, phase: FailurePhase, safeMessage?: string, options?: { cause?: unknown }) {
    super(code, safeMessage, options);
    this.name = 'ProviderError';
    this.phase = phase;
  }
}

export type ProviderConnectionState =
  | 'not_installed'
  | 'needs_login'
  | 'ready'
  | 'busy'
  | 'quota_limited'
  | 'unsupported'
  | 'error';

export const ASPECT_RATIOS = ['9:16', '16:9', '1:1'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface GenerateVideoInput {
  sku: string;
  /** Absolute local path of the validated source image (never sent to the provider as a path). */
  sourceImagePath: string;
  /** Safe file name, metadata only (e.g. X-File-Name). */
  sourceFileName: string;
  prompt: string;
  /** Stable UUID per internal job; used as Idempotency-Key. Same value on every retry of the same job. */
  requestId: string;
  durationSeconds?: number;
  aspectRatio?: AspectRatio;
}

export type ProviderJobState =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ambiguous';

export interface ProviderJob {
  /** Empty string only when state is 'ambiguous' and no id was received. */
  providerJobId: string;
  state: ProviderJobState;
  /** Only set when the provider genuinely reports progress (0..1). Never fabricated. */
  progress?: number;
  /** Provider asset id of the generated video, when available. */
  providerAssetId?: string;
  /** Provider reference id of the uploaded source image. */
  providerReferenceId?: string;
  errorCode?: ErrorCode;
  safeMessage?: string;
}

/** Capabilities derived from the actual bridge (e.g. /v1/status). UI hides what is unsupported. */
export interface ProviderCapabilities {
  canCancel: boolean;
  reportsProgress: boolean;
  /** Empty = provider does not expose duration control; UI hides it. */
  supportedDurations: number[];
  /** Empty = provider does not expose aspect control; UI hides it. */
  supportedAspectRatios: AspectRatio[];
  maxPromptChars: number;
  maxUploadBytes: number;
}

export interface DownloadResult {
  /** Bytes written to destPath. */
  bytes: number;
}

/**
 * Where a provider failure happened relative to acceptance. Only 'before_submit' failures may be retried
 * (brief §4.5). Carried by ProviderError.
 */
export type FailurePhase = 'before_submit' | 'after_submit' | 'unknown';

export interface MuseProvider {
  readonly kind: 'mock' | 'bridge';
  getConnectionState(): Promise<ProviderConnectionState>;
  getCapabilities(): Promise<ProviderCapabilities>;
  /**
   * Uploads the source image and submits ONE video job. Must never submit twice for the same requestId.
   * Returns state 'queued'/'running' when acceptance is confirmed, or 'ambiguous' when the request may have
   * been accepted but this could not be confirmed. Throws ProviderError for definite failures.
   */
  generateVideo(input: GenerateVideoInput): Promise<ProviderJob>;
  getJob(providerJobId: string): Promise<ProviderJob>;
  /**
   * Optional: look up a job by the idempotency key/requestId (used to reconcile AMBIGUOUS jobs).
   * Returns null when the provider confirms no such job exists, throws when it cannot tell.
   */
  findJobByRequestId?(requestId: string): Promise<ProviderJob | null>;
  /**
   * Downloads the generated MP4 of a succeeded job to destPath (a temp `.part` file chosen by the caller),
   * enforcing maxBytes and validating the download URL against the approved bridge origin.
   * Throws ProviderError with code 'OUTPUT_MISSING' or 'DOWNLOAD_FAILED'.
   */
  downloadOutput(providerJobId: string, destPath: string, maxBytes: number): Promise<DownloadResult>;
  /** Present only if the bridge genuinely supports cancel. */
  cancelJob?(providerJobId: string): Promise<void>;
}
