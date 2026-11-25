/**
 * Mapping between Muse4AI bridge payloads (agent API 2.0.0-beta.35) and POD Video Studio domain models.
 */
import type { ProviderCapabilities, ProviderConnectionState, ProviderJobState } from '@shared/provider';
import type { ErrorCode } from '@shared/errors';
import type { MuseSubmitMode } from '@shared/config';
import type { BridgeJob, StatusResponse } from './endpoints';

/** Muse4AI chat prompt limit (`limits.chat_prompt_max_chars`). */
export const CHAT_PROMPT_MAX_DEFAULT = 32000;

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  canCancel: false,
  reportsProgress: false,
  supportedDurations: [],
  supportedAspectRatios: [],
  maxPromptChars: 4000,
  maxUploadBytes: 20 * 1024 * 1024,
};

/**
 * Maps the public Muse4AI job `status` to ProviderJobState.
 * `needs_review` = Muse4AI cannot prove whether Muse received/finished the job; a person must check in
 * Muse4AI — it is never resubmitted, so it maps to 'ambiguous'. Unknown values are treated the same way
 * (stop and ask a human) rather than guessing success/failure.
 */
export function mapBridgeJobState(status: string): ProviderJobState {
  switch (status.toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'needs_review':
    default:
      return 'ambiguous';
  }
}

/** Maps a failed job's Muse4AI `error.code` (ErrorClass) to a safe ErrorCode. */
export function mapBridgeJobError(code: string | undefined | null): ErrorCode {
  switch ((code ?? '').toUpperCase()) {
    case 'QUOTA_LIMIT':
      return 'QUOTA_LIMITED';
    case 'CONTENT_REFUSED':
      return 'CONTENT_REFUSED';
    case 'SESSION_EXPIRED':
    case 'CHECKPOINT':
      return 'NEEDS_LOGIN';
    case 'DOWNLOAD_FAILED':
      return 'DOWNLOAD_FAILED';
    case 'AMBIGUOUS_SUBMIT':
      return 'SUBMIT_AMBIGUOUS';
    case 'PROXY_FAILED':
    case 'PRE_SUBMIT_TRANSIENT':
    case 'NOT_ACCEPTED':
    case 'HTTP_CONNECT_FAILED':
      return 'NOT_CONNECTED';
    default:
      // PROVIDER_ERROR, EMPTY_RESPONSE, UI_CHANGED, HTTP_*, ANOMALY_REPORTED, UNKNOWN …
      return 'PROVIDER_ERROR';
  }
}

/** Picks the downloadable video output of a succeeded job. */
export function pickVideoAssetId(job: BridgeJob): string | undefined {
  const outputs = job.outputs ?? [];
  const video =
    outputs.find((o) => o.available !== false && (o.kind === 'video' || o.mime === 'video/mp4')) ??
    outputs.find((o) => o.kind === 'video' || o.mime === 'video/mp4');
  return video?.asset_id;
}

/**
 * Derives ProviderCapabilities from /v1/status. Muse4AI's create-job schema has no duration or aspect-ratio
 * field (additionalProperties: false), so those controls stay hidden. Progress is not reported.
 */
export function mapBridgeCapabilities(
  status: StatusResponse | undefined,
  mode: MuseSubmitMode = 'chat'
): ProviderCapabilities {
  if (!status) {
    return mode === 'chat' ? { ...DEFAULT_CAPABILITIES, maxPromptChars: CHAT_PROMPT_MAX_DEFAULT } : { ...DEFAULT_CAPABILITIES };
  }
  const maxPromptChars =
    mode === 'chat'
      ? status.limits?.chat_prompt_max_chars ?? CHAT_PROMPT_MAX_DEFAULT
      : status.limits?.prompt_max_chars ?? DEFAULT_CAPABILITIES.maxPromptChars;
  return {
    // POST /v1/jobs/{id}/cancel exists; a "status only" key cannot create or cancel anything anyway.
    canCancel: status.key?.scope !== undefined && status.key.scope !== 'status',
    reportsProgress: false,
    supportedDurations: [],
    supportedAspectRatios: [],
    maxPromptChars,
    maxUploadBytes: status.limits?.upload_max_bytes ?? DEFAULT_CAPABILITIES.maxUploadBytes,
  };
}

/** Maps /v1/status (capabilities + account groups/quota) to ProviderConnectionState. */
export function mapBridgeConnectionState(status: StatusResponse, mode: MuseSubmitMode = 'chat'): ProviderConnectionState {
  if (mode === 'chat' && status.capabilities && status.capabilities.chat === false) return 'error';
  if (mode === 'video' && status.capabilities && status.capabilities.video_from_image === false) return 'error';
  if (status.key?.scope === 'status') return 'error';

  const acc = status.accounts;
  if (!acc) return 'error';
  const items = acc.items ?? [];
  const usable = items.filter((i) => {
    const tier = i.quota?.tier;
    return tier !== 'exhausted' && tier !== 'weekly_full';
  });

  if ((acc.ready ?? 0) > 0 && (items.length === 0 || usable.some((i) => i.group === 'ready'))) return 'ready';
  if (items.length > 0 && usable.length === 0) return 'quota_limited';
  if ((acc.busy ?? 0) > 0 || (acc.waiting ?? 0) > 0) return 'busy';
  if ((acc.needs_user ?? 0) > 0 || (acc.total ?? 0) === 0) return 'needs_login';
  if ((acc.ready ?? 0) > 0) return 'quota_limited';
  return 'error';
}

/** Maps HTTP status codes to safe ErrorCodes. */
export function mapHttpStatusToErrorCode(status: number): ErrorCode {
  if (status === 401) return 'NEEDS_LOGIN';
  if (status === 403 || status === 422) return 'CONTENT_REFUSED';
  if (status === 429) return 'QUOTA_LIMITED';
  if (status === 404) return 'NOT_FOUND';
  return 'PROVIDER_ERROR';
}
