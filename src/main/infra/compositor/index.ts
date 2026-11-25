import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PodError } from '@shared/errors';
import type {
  CalendarArtworkCompositor,
  CalendarCompositionInput,
  CalendarCompositionReport,
  Logger,
} from '@shared/services';

export const CalendarCompositionReportSchema = z.object({
  applied: z.boolean(),
  artworkSha256: z.string().min(64).max(64),
  processedFrames: z.number().int().nonnegative(),
  visibleFrames: z.number().int().nonnegative(),
  trackingCoverage: z.number().min(0).max(1),
  lowConfidenceFrames: z.number().int().nonnegative(),
  compositorVersion: z.string().min(1),
});

export interface CreateCalendarCompositorOpts {
  resourcesDir: string;
  tempDir: string;
  logger: Logger;
  timeoutMs?: number;
  /** Internal test-only override for sidecar executable */
  _testSidecarExePath?: string;
  _testFfmpegExePath?: string;
  _testFfprobeExePath?: string;
  _testSpawnOverride?: (
    command: string,
    args: readonly string[],
    options: { shell: false; windowsHide: true }
  ) => ChildProcess;
}

export interface CalendarArtworkCompositorWithDispose extends CalendarArtworkCompositor {
  dispose(): void;
}

function isInsideDirectory(parentDir: string, candidatePath: string): boolean {
  try {
    const resolvedParent = resolve(parentDir);
    const resolvedCandidate = resolve(candidatePath);
    const rel = relative(resolvedParent, resolvedCandidate);
    return !rel.startsWith('..') && !isAbsolute(rel) && rel !== '';
  } catch {
    return false;
  }
}

export function createUnavailableCompositor(): CalendarArtworkCompositor {
  return {
    async process(): Promise<CalendarCompositionReport> {
      throw new PodError('CALENDAR_COMPOSITING_FAILED');
    },
  };
}

export function createCalendarCompositor(
  opts: CreateCalendarCompositorOpts
): CalendarArtworkCompositorWithDispose {
  const { resourcesDir, tempDir, logger, timeoutMs = 10 * 60 * 1000 } = opts;

  const allowedDir = resolve(resourcesDir, 'calendar-compositor');
  const sidecarExe = opts._testSidecarExePath ?? join(allowedDir, 'calendar-compositor.exe');
  const ffmpegExe = opts._testFfmpegExePath ?? join(allowedDir, 'ffmpeg.exe');
  const ffprobeExe = opts._testFfprobeExePath ?? join(allowedDir, 'ffprobe.exe');

  // Verify executable is strictly inside allowedDir
  let realExe: string;
  try {
    realExe = existsSync(sidecarExe) ? realpathSync(sidecarExe) : resolve(sidecarExe);
  } catch {
    realExe = resolve(sidecarExe);
  }

  let realAllowed: string;
  try {
    realAllowed = existsSync(allowedDir) ? realpathSync(allowedDir) : resolve(allowedDir);
  } catch {
    realAllowed = resolve(allowedDir);
  }

  const relExe = relative(realAllowed, realExe);
  if (relExe.startsWith('..') || isAbsolute(relExe)) {
    logger.error('calendar_compositor_refused_external_executable', {
      reason: 'executable_outside_resources_dir',
    });
    throw new PodError('CALENDAR_COMPOSITING_FAILED', 'Executable outside allowed directory');
  }

  const liveChildren = new Set<ChildProcess>();

  function killProcessTree(child: ChildProcess): void {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Ignore kill failures
    }
  }

  return {
    dispose(): void {
      for (const child of liveChildren) {
        killProcessTree(child);
      }
      liveChildren.clear();
    },

    async process(input: CalendarCompositionInput): Promise<CalendarCompositionReport> {
      const { inputVideoPath, artworkPath, outputVideoPath, sku, jobId } = input;
      const startTime = Date.now();

      logger.info('calendar_compositing_started', { jobId, sku });

      // Validate paths
      if (!isAbsolute(artworkPath) || !existsSync(artworkPath)) {
        logger.error('calendar_compositor_invalid_path', { jobId, sku, target: 'artwork' });
        throw new PodError('CALENDAR_COMPOSITING_FAILED', 'Invalid artwork path');
      }

      if (!isAbsolute(inputVideoPath) || !existsSync(inputVideoPath)) {
        logger.error('calendar_compositor_invalid_path', { jobId, sku, target: 'input' });
        throw new PodError('CALENDAR_COMPOSITING_FAILED', 'Invalid input video path');
      }

      if (!isAbsolute(outputVideoPath)) {
        logger.error('calendar_compositor_invalid_path', { jobId, sku, target: 'output' });
        throw new PodError('CALENDAR_COMPOSITING_FAILED', 'Invalid output video path');
      }

      // Check output is inside tempDir
      if (!isInsideDirectory(tempDir, outputVideoPath)) {
        logger.error('calendar_compositor_invalid_path', { jobId, sku, target: 'output_not_in_temp' });
        throw new PodError('CALENDAR_COMPOSITING_FAILED', 'Output path not in temp directory');
      }

      const reportPath = join(tempDir, `cal-report-${randomUUID()}.json`);

      const args = [
        '--input',
        inputVideoPath,
        '--artwork',
        artworkPath,
        '--output',
        outputVideoPath,
        '--ffmpeg',
        ffmpegExe,
        '--ffprobe',
        ffprobeExe,
        '--report',
        reportPath,
      ];

      let child: ChildProcess | undefined;
      let timedOut = false;

      try {
        const exitCode = await new Promise<number>((res, rej) => {
          let timer: NodeJS.Timeout | undefined;

          try {
            if (opts._testSpawnOverride) {
              child = opts._testSpawnOverride(sidecarExe, args, {
                shell: false,
                windowsHide: true,
              });
            } else {
              child = spawn(sidecarExe, args, {
                shell: false,
                windowsHide: true,
              });
            }
          } catch (err) {
            return rej(err);
          }

          liveChildren.add(child);

          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              timedOut = true;
              if (child) {
                killProcessTree(child);
              }
              rej(new Error('Process timed out'));
            }, timeoutMs);
          }

          child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            if (child) liveChildren.delete(child);
            rej(err);
          });

          child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (child) liveChildren.delete(child);
            res(code ?? 1);
          });
        });

        const durationMs = Date.now() - startTime;

        if (exitCode !== 0) {
          logger.warn('calendar_compositing_failed', {
            jobId,
            sku,
            exitCode,
            durationMs,
          });
          if (existsSync(outputVideoPath)) {
            try {
              unlinkSync(outputVideoPath);
            } catch {
              // Ignore cleanup error
            }
          }
          throw new PodError('CALENDAR_COMPOSITING_FAILED');
        }

        // Parse and validate report
        if (!existsSync(reportPath)) {
          logger.error('calendar_compositor_missing_report', { jobId, sku, durationMs });
          if (existsSync(outputVideoPath)) {
            try {
              unlinkSync(outputVideoPath);
            } catch {
              // Ignore cleanup error
            }
          }
          throw new PodError('CALENDAR_COMPOSITING_FAILED');
        }

        const reportRaw = await fs.readFile(reportPath, 'utf-8');
        let reportJson: unknown;
        try {
          reportJson = JSON.parse(reportRaw);
        } catch {
          logger.error('calendar_compositor_malformed_report', { jobId, sku, durationMs });
          if (existsSync(outputVideoPath)) {
            try {
              unlinkSync(outputVideoPath);
            } catch {
              // Ignore cleanup error
            }
          }
          throw new PodError('CALENDAR_COMPOSITING_FAILED');
        }

        const parseResult = CalendarCompositionReportSchema.safeParse(reportJson);
        if (!parseResult.success) {
          logger.error('calendar_compositor_invalid_report_schema', { jobId, sku, durationMs });
          if (existsSync(outputVideoPath)) {
            try {
              unlinkSync(outputVideoPath);
            } catch {
              // Ignore cleanup error
            }
          }
          throw new PodError('CALENDAR_COMPOSITING_FAILED');
        }

        const report = parseResult.data;
        if (!report.applied) {
          logger.warn('calendar_compositing_rejected', {
            jobId,
            sku,
            visibleFrames: report.visibleFrames,
            trackingCoverage: report.trackingCoverage,
            durationMs,
          });
          if (existsSync(outputVideoPath)) {
            try {
              unlinkSync(outputVideoPath);
            } catch {
              // Ignore cleanup error
            }
          }
          throw new PodError('CALENDAR_COMPOSITING_FAILED');
        }

        logger.info('calendar_compositing_completed', {
          jobId,
          sku,
          exitCode: 0,
          durationMs,
          processedFrames: report.processedFrames,
          visibleFrames: report.visibleFrames,
          trackingCoverage: report.trackingCoverage,
        });

        return report;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        if (timedOut) {
          logger.error('calendar_compositing_timeout', { jobId, sku, durationMs });
        }
        if (existsSync(outputVideoPath)) {
          try {
            unlinkSync(outputVideoPath);
          } catch {
            // Ignore
          }
        }
        if (err instanceof PodError) {
          throw err;
        }
        throw new PodError('CALENDAR_COMPOSITING_FAILED');
      } finally {
        if (existsSync(reportPath)) {
          try {
            unlinkSync(reportPath);
          } catch {
            // Ignore
          }
        }
      }
    },
  };
}
