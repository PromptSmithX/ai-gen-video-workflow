/** Error codes from brief §4.5 plus local validation codes. Safe to show/log (no sensitive data). */
export const ERROR_CODES = [
  'NOT_CONNECTED',
  'NEEDS_LOGIN',
  'UNSUPPORTED_PLATFORM',
  'QUOTA_LIMITED',
  'CONTENT_REFUSED',
  'PROVIDER_ERROR',
  'SUBMIT_AMBIGUOUS',
  'OUTPUT_MISSING',
  'DOWNLOAD_FAILED',
  'CALENDAR_COMPOSITING_FAILED',
  // local / validation
  'INVALID_SKU',
  'INVALID_IMAGE',
  'IMAGE_TOO_LARGE',
  'INVALID_PROMPT',
  'PROMPT_TOO_LONG',
  'TEMPLATE_NOT_FOUND',
  'SECRET_STORE_UNAVAILABLE',
  'CONFIG_INVALID',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_STATE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Default employee-facing messages. Never include prompt text, paths, tokens or provider internals. */
export const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  NOT_CONNECTED: 'The Muse bridge is not running or cannot be reached. Start it and try again.',
  NEEDS_LOGIN: 'Please sign in to Muse through the normal Muse login, then try again.',
  UNSUPPORTED_PLATFORM: 'The configured Muse platform is not supported by this integration. Contact an admin.',
  QUOTA_LIMITED: 'Muse reports that the generation quota/credits are exhausted. Generation stopped.',
  CONTENT_REFUSED: 'Muse refused this request. The artwork was not changed. Contact an admin if this is unexpected.',
  PROVIDER_ERROR: 'Muse reported a technical error. You may retry once.',
  SUBMIT_AMBIGUOUS:
    'The request may already have been sent to Muse, but it could not be confirmed. It will NOT be resent automatically. Check Muse before retrying.',
  OUTPUT_MISSING: 'Muse marked the job complete but no video was delivered.',
  DOWNLOAD_FAILED: 'The video was generated but could not be downloaded or validated.',
  CALENDAR_COMPOSITING_FAILED:
    'The video was generated, but the interior artwork could not be placed reliably on the calendar page. Retry the download to process it again; no new generation will be submitted.',
  INVALID_SKU: 'SKU may only contain A-Z, 0-9, hyphen and underscore.',
  INVALID_IMAGE: 'The image must be a valid PNG, JPEG or WEBP file.',
  IMAGE_TOO_LARGE: 'The image is too large.',
  INVALID_PROMPT: 'The prompt failed validation.',
  PROMPT_TOO_LONG: 'The prompt is longer than the allowed limit.',
  TEMPLATE_NOT_FOUND: 'The selected prompt template was not found.',
  SECRET_STORE_UNAVAILABLE: 'Secure Windows credential storage is unavailable, so the secret was not saved.',
  CONFIG_INVALID: 'The application configuration is invalid. Contact an admin.',
  FORBIDDEN: 'Only admins can do this.',
  NOT_FOUND: 'The item was not found.',
  INVALID_STATE: 'This action is not allowed in the current state.',
  INTERNAL: 'An unexpected error occurred.',
};

/** Error with a safe code. `safeMessage` must never contain secrets, prompt text or raw paths. */
export class PodError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  constructor(code: ErrorCode, safeMessage?: string, options?: { cause?: unknown }) {
    super(safeMessage ?? SAFE_ERROR_MESSAGES[code], options);
    this.name = 'PodError';
    this.code = code;
    this.safeMessage = safeMessage ?? SAFE_ERROR_MESSAGES[code];
  }
}

/** Serializable error shape passed over IPC. */
export interface SafeError {
  code: ErrorCode;
  message: string;
}

/** IPC result envelope: main never throws raw errors across the boundary. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SafeError };
