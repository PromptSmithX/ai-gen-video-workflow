import { describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import type { JobState } from '@shared/job-state';
import type { ProviderCapabilities } from '@shared/provider';
import { assertTransition, isActive, isTerminal, nextActionsFor } from './job-machine';

describe('job-machine', () => {
  describe('assertTransition', () => {
    it('allows valid transitions', () => {
      expect(() => assertTransition('QUEUED', 'SUBMITTING')).not.toThrow();
      expect(() => assertTransition('SUBMITTING', 'RUNNING')).not.toThrow();
      expect(() => assertTransition('RUNNING', 'DOWNLOADING')).not.toThrow();
      expect(() => assertTransition('DOWNLOADING', 'SUCCEEDED')).not.toThrow();
    });

    it('throws PodError(INVALID_STATE) on forbidden transitions', () => {
      expect(() => assertTransition('SUCCEEDED', 'QUEUED')).toThrow(PodError);
      try {
        assertTransition('SUCCEEDED', 'QUEUED');
      } catch (err: unknown) {
        expect((err as PodError).code).toBe('INVALID_STATE');
      }

      expect(() => assertTransition('CANCELLED', 'RUNNING')).toThrow(PodError);
      expect(() => assertTransition('DRAFT', 'RUNNING')).toThrow(PodError);
    });
  });

  describe('isTerminal and isActive', () => {
    it('correctly classifies terminal states', () => {
      const terminals: JobState[] = [
        'SUCCEEDED',
        'FAILED_RETRYABLE',
        'AMBIGUOUS',
        'FAILED_REFUSED',
        'FAILED_QUOTA',
        'FAILED_PROVIDER',
        'DOWNLOAD_FAILED',
        'CANCELLED',
      ];
      for (const s of terminals) {
        expect(isTerminal(s)).toBe(true);
      }
      expect(isTerminal('QUEUED')).toBe(false);
      expect(isTerminal('RUNNING')).toBe(false);
    });

    it('correctly classifies active states', () => {
      const actives: JobState[] = ['QUEUED', 'SUBMITTING', 'RUNNING', 'DOWNLOADING'];
      for (const s of actives) {
        expect(isActive(s)).toBe(true);
      }
      expect(isActive('SUCCEEDED')).toBe(false);
      expect(isActive('CANCELLED')).toBe(false);
    });
  });

  describe('nextActionsFor table test', () => {
    const capCanCancel: ProviderCapabilities = {
      canCancel: true,
      reportsProgress: true,
      supportedDurations: [5, 10],
      supportedAspectRatios: ['9:16'],
      maxPromptChars: 4000,
      maxUploadBytes: 50 * 1024 * 1024,
    };

    const capNoCancel: ProviderCapabilities = {
      ...capCanCancel,
      canCancel: false,
    };

    const cases: Array<{
      desc: string;
      job: { state: JobState; attempt: number };
      capabilities?: ProviderCapabilities | null;
      expected: string[];
    }> = [
      {
        desc: 'FAILED_RETRYABLE -> retry',
        job: { state: 'FAILED_RETRYABLE', attempt: 0 },
        expected: ['retry'],
      },
      {
        desc: 'FAILED_PROVIDER with attempt 0 (< 2) -> retry, regenerate',
        job: { state: 'FAILED_PROVIDER', attempt: 0 },
        expected: ['retry', 'regenerate'],
      },
      {
        desc: 'FAILED_PROVIDER with attempt 1 (< 2) -> retry, regenerate',
        job: { state: 'FAILED_PROVIDER', attempt: 1 },
        expected: ['retry', 'regenerate'],
      },
      {
        desc: 'FAILED_PROVIDER with attempt 2 (>= 2) -> regenerate only',
        job: { state: 'FAILED_PROVIDER', attempt: 2 },
        expected: ['regenerate'],
      },
      {
        desc: 'FAILED_PROVIDER with attempt 3 (>= 2) -> regenerate only',
        job: { state: 'FAILED_PROVIDER', attempt: 3 },
        expected: ['regenerate'],
      },
      {
        desc: 'AMBIGUOUS -> check_ambiguous',
        job: { state: 'AMBIGUOUS', attempt: 0 },
        expected: ['check_ambiguous'],
      },
      {
        desc: 'DOWNLOAD_FAILED -> retry_download',
        job: { state: 'DOWNLOAD_FAILED', attempt: 0 },
        expected: ['retry_download'],
      },
      {
        desc: 'SUCCEEDED -> regenerate',
        job: { state: 'SUCCEEDED', attempt: 0 },
        expected: ['regenerate'],
      },
      {
        desc: 'FAILED_REFUSED -> regenerate',
        job: { state: 'FAILED_REFUSED', attempt: 0 },
        expected: ['regenerate'],
      },
      {
        desc: 'FAILED_QUOTA -> regenerate',
        job: { state: 'FAILED_QUOTA', attempt: 0 },
        expected: ['regenerate'],
      },
      {
        desc: 'CANCELLED -> regenerate',
        job: { state: 'CANCELLED', attempt: 0 },
        expected: ['regenerate'],
      },
      {
        desc: 'QUEUED with canCancel -> cancel',
        job: { state: 'QUEUED', attempt: 0 },
        capabilities: capCanCancel,
        expected: ['cancel'],
      },
      {
        desc: 'QUEUED without canCancel -> none',
        job: { state: 'QUEUED', attempt: 0 },
        capabilities: capNoCancel,
        expected: ['none'],
      },
      {
        desc: 'QUEUED without capabilities -> none',
        job: { state: 'QUEUED', attempt: 0 },
        capabilities: null,
        expected: ['none'],
      },
      {
        desc: 'RUNNING with canCancel -> cancel',
        job: { state: 'RUNNING', attempt: 0 },
        capabilities: capCanCancel,
        expected: ['cancel'],
      },
      {
        desc: 'RUNNING without canCancel -> none',
        job: { state: 'RUNNING', attempt: 0 },
        capabilities: capNoCancel,
        expected: ['none'],
      },
      {
        desc: 'SUBMITTING -> none',
        job: { state: 'SUBMITTING', attempt: 0 },
        expected: ['none'],
      },
      {
        desc: 'DOWNLOADING -> none',
        job: { state: 'DOWNLOADING', attempt: 0 },
        expected: ['none'],
      },
      {
        desc: 'DRAFT -> none',
        job: { state: 'DRAFT', attempt: 0 },
        expected: ['none'],
      },
      {
        desc: 'READY -> none',
        job: { state: 'READY', attempt: 0 },
        expected: ['none'],
      },
    ];

    for (const c of cases) {
      it(c.desc, () => {
        const result = nextActionsFor(c.job, c.capabilities);
        expect(result).toEqual(c.expected);
      });
    }
  });
});
