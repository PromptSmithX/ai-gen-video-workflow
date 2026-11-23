/**
 * Mapping between bridge HTTP status/payloads and POD Video Studio domain models.
 */
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type ProviderCapabilities,
  type ProviderConnectionState,
  type ProviderJobState,
} from '@shared/provider';
import type { ErrorCode } from '@shared/errors';
import type { StatusResponse } from './endpoints';

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  canCancel: false,
  reportsProgress: false,
  supportedDurations: [],
  supportedAspectRatios: [],
  maxPromptChars: 4000,
  maxUploadBytes: 20 * 1024 * 1024,
};

/**
 * Maps raw bridge job state strings to ProviderJobState.
 */
export function mapBridgeJobState(rawState: string): ProviderJobState {
  const s = rawState.toLowerCase();
  switch (s) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'submitting':
      return 'submitting';
    case 'running':
    case 'processing':
      return 'running';
    case 'succeeded':
    case 'completed':
    case 'done':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'ambiguous':
      return 'ambiguous';
    default:
      return 'failed';
  }
}

/**
 * Derives ProviderCapabilities from /v1/status capabilities or conservative defaults.
 */
export function mapBridgeCapabilities(raw?: StatusResponse['capabilities']): ProviderCapabilities {
  if (!raw) return { ...DEFAULT_CAPABILITIES };

  const supportedAspectRatios = (raw.supported_aspect_ratios ?? raw.supportedAspectRatios ?? []).filter(
    (ar): ar is AspectRatio => (ASPECT_RATIOS as readonly string[]).includes(ar)
  );

  return {
    canCancel: raw.can_cancel ?? raw.canCancel ?? false,
    reportsProgress: raw.reports_progress ?? raw.reportsProgress ?? false,
    supportedDurations: raw.supported_durations ?? raw.supportedDurations ?? [],
    supportedAspectRatios,
    maxPromptChars: raw.max_prompt_chars ?? raw.maxPromptChars ?? 4000,
    maxUploadBytes: raw.max_upload_bytes ?? raw.maxUploadBytes ?? 20 * 1024 * 1024,
  };
}

/**
 * Maps bridge /v1/status payload to ProviderConnectionState.
 */
export function mapBridgeConnectionState(statusData: StatusResponse): ProviderConnectionState {
  if (statusData.needs_login === true || statusData.login_required === true || statusData.status === 'needs_login') {
    return 'needs_login';
  }
  if (statusData.quota_limited === true || statusData.quota_exhausted === true || statusData.status === 'quota_limited') {
    return 'quota_limited';
  }
  if (statusData.busy === true || statusData.status === 'busy') {
    return 'busy';
  }
  if (statusData.status === 'ready' || statusData.status === 'ok' || statusData.authenticated === true) {
    return 'ready';
  }
  if (statusData.status === 'not_installed') {
    return 'not_installed';
  }
  return 'error';
}

/**
 * Maps HTTP status codes to safe ErrorCodes.
 */
export function mapHttpStatusToErrorCode(status: number): ErrorCode {
  if (status === 401) return 'NEEDS_LOGIN';
  if (status === 403 || status === 422) return 'CONTENT_REFUSED';
  if (status === 429) return 'QUOTA_LIMITED';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500 && status <= 599) return 'PROVIDER_ERROR';
  return 'PROVIDER_ERROR';
}
