import type { Job } from '@shared/domain';
import { PodError } from '@shared/errors';
import type { JobNextAction } from '@shared/ipc';
import {
  ACTIVE_JOB_STATES,
  canTransition,
  TERMINAL_JOB_STATES,
  type JobState,
} from '@shared/job-state';
import type { ProviderCapabilities } from '@shared/provider';

/**
 * Asserts that a state transition is allowed; throws PodError('INVALID_STATE') if not.
 */
export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new PodError('INVALID_STATE', `Cannot transition job from ${from} to ${to}`);
  }
}

/**
 * Checks whether a job state is terminal.
 */
export function isTerminal(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly JobState[]).includes(state);
}

/**
 * Checks whether a job state is active (in flight).
 */
export function isActive(state: JobState): boolean {
  return (ACTIVE_JOB_STATES as readonly JobState[]).includes(state);
}

/**
 * Determines available next actions for a job according to rules:
 * - FAILED_RETRYABLE -> retry
 * - FAILED_PROVIDER -> retry only if job.attempt < 2, plus regenerate
 * - AMBIGUOUS -> check_ambiguous
 * - DOWNLOAD_FAILED -> retry_download
 * - SUCCEEDED / FAILED_REFUSED / FAILED_QUOTA / CANCELLED -> regenerate
 * - QUEUED / RUNNING -> cancel only if capabilities?.canCancel; else none
 * - else -> none
 */
export function nextActionsFor(
  job: Pick<Job, 'state' | 'attempt'>,
  capabilities?: ProviderCapabilities | null,
): JobNextAction[] {
  switch (job.state) {
    case 'FAILED_RETRYABLE':
      return ['retry'];

    case 'FAILED_PROVIDER':
      if (job.attempt < 2) {
        return ['retry', 'regenerate'];
      }
      return ['regenerate'];

    case 'AMBIGUOUS':
      return ['check_ambiguous'];

    case 'DOWNLOAD_FAILED':
      return ['retry_download'];

    case 'SUCCEEDED':
    case 'FAILED_REFUSED':
    case 'FAILED_QUOTA':
    case 'CANCELLED':
      return ['regenerate'];

    case 'QUEUED':
    case 'RUNNING':
      if (capabilities?.canCancel) {
        return ['cancel'];
      }
      return ['none'];

    default:
      return ['none'];
  }
}
