/** Internal job state machine, brief §8. DRAFT/READY live only in the UI; persisted jobs start at QUEUED. */
export const JOB_STATES = [
  'DRAFT',
  'READY',
  'QUEUED',
  'SUBMITTING',
  'RUNNING',
  'DOWNLOADING',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'AMBIGUOUS',
  'FAILED_REFUSED',
  'FAILED_QUOTA',
  'FAILED_PROVIDER',
  'DOWNLOAD_FAILED',
  'CANCELLED',
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'AMBIGUOUS',
  'FAILED_REFUSED',
  'FAILED_QUOTA',
  'FAILED_PROVIDER',
  'DOWNLOAD_FAILED',
  'CANCELLED',
];

/** States in which work may be in flight (restored + reconciled on restart). */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['QUEUED', 'SUBMITTING', 'RUNNING', 'DOWNLOADING'];

/** Allowed transitions. Anything not listed is rejected by the domain state machine. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  DRAFT: ['READY'],
  READY: ['QUEUED', 'DRAFT'],
  QUEUED: ['SUBMITTING', 'CANCELLED', 'FAILED_RETRYABLE'],
  // SUBMITTING -> FAILED_RETRYABLE only when the request definitely never reached the provider.
  // SUBMITTING -> AMBIGUOUS when it may have been accepted (also the restart-recovery path).
  SUBMITTING: ['RUNNING', 'FAILED_RETRYABLE', 'AMBIGUOUS', 'FAILED_REFUSED', 'FAILED_QUOTA', 'FAILED_PROVIDER'],
  // RUNNING -> AMBIGUOUS when the provider no longer knows the accepted job (e.g. 404 while polling).
  RUNNING: ['DOWNLOADING', 'FAILED_REFUSED', 'FAILED_QUOTA', 'FAILED_PROVIDER', 'CANCELLED', 'DOWNLOAD_FAILED', 'AMBIGUOUS'],
  DOWNLOADING: ['SUCCEEDED', 'DOWNLOAD_FAILED'],
  SUCCEEDED: [],
  // Manual retry (user acknowledged) re-queues the SAME job + SAME idempotency key.
  FAILED_RETRYABLE: ['QUEUED'],
  // Ambiguous is resolved only by reconciliation with the provider or explicit user decision.
  AMBIGUOUS: ['RUNNING', 'FAILED_PROVIDER', 'CANCELLED'],
  FAILED_REFUSED: [],
  FAILED_QUOTA: [],
  // One manual retry after user acknowledgement (brief §4.5 PROVIDER_ERROR).
  FAILED_PROVIDER: ['QUEUED'],
  // A completed generation can be downloaded again without a new generation.
  DOWNLOAD_FAILED: ['DOWNLOADING'],
  CANCELLED: [],
};

/** Employee-facing labels (Queue screen, brief §5 B). */
export const JOB_STATE_LABELS: Readonly<Record<JobState, string>> = {
  DRAFT: 'Draft',
  READY: 'Ready',
  QUEUED: 'Queued',
  SUBMITTING: 'Submitting',
  RUNNING: 'Generating',
  DOWNLOADING: 'Downloading',
  SUCCEEDED: 'Completed',
  FAILED_RETRYABLE: 'Failed (not sent)',
  AMBIGUOUS: 'Needs check (may have been sent)',
  FAILED_REFUSED: 'Refused by Muse',
  FAILED_QUOTA: 'Quota exhausted',
  FAILED_PROVIDER: 'Failed',
  DOWNLOAD_FAILED: 'Download failed',
  CANCELLED: 'Cancelled',
};

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
