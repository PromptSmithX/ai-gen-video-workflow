import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  createCalendarCompositor,
  createUnavailableCompositor,
} from './index';
import { PodError } from '@shared/errors';
import type { LogFields, Logger } from '@shared/services';

describe('CalendarArtworkCompositor Adapter', () => {
  let tempDir: string;
  let resourcesDir: string;
  let sidecarDir: string;
  let loggedEvents: Array<{ level: string; event: string; fields?: LogFields }>;
  let mockLogger: Logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-comp-test-'));
    resourcesDir = path.join(tempDir, 'resources');
    sidecarDir = path.join(resourcesDir, 'calendar-compositor');
    fs.mkdirSync(sidecarDir, { recursive: true });

    loggedEvents = [];
    const makeLogger = (inherited: LogFields = {}): Logger => ({
      debug: (event, fields) => loggedEvents.push({ level: 'debug', event, fields: { ...inherited, ...fields } }),
      info: (event, fields) => loggedEvents.push({ level: 'info', event, fields: { ...inherited, ...fields } }),
      warn: (event, fields) => loggedEvents.push({ level: 'warn', event, fields: { ...inherited, ...fields } }),
      error: (event, fields) => loggedEvents.push({ level: 'error', event, fields: { ...inherited, ...fields } }),
      child: (fields) => makeLogger({ ...inherited, ...fields }),
    });
    mockLogger = makeLogger();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createFakeSidecarScript(scriptContent: string): string {
    const scriptPath = path.join(sidecarDir, `fake-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
    return scriptPath;
  }

  it('createUnavailableCompositor throws CALENDAR_COMPOSITING_FAILED', async () => {
    const compositor = createUnavailableCompositor();
    await expect(
      compositor.process({
        inputVideoPath: path.join(tempDir, 'in.mp4'),
        artworkPath: path.join(tempDir, 'art.png'),
        outputVideoPath: path.join(tempDir, 'out.mp4'),
        sku: 'CAL-001',
        jobId: 'job-123',
      })
    ).rejects.toThrowError(PodError);
  });

  it('refuses executable outside resources dir', () => {
    const outsideExe = path.join(tempDir, 'outside-sidecar.exe');
    fs.writeFileSync(outsideExe, '');

    expect(() =>
      createCalendarCompositor({
        resourcesDir,
        tempDir,
        logger: mockLogger,
        _testSidecarExePath: outsideExe,
      })
    ).toThrowError(PodError);

    const errorLogs = loggedEvents.filter((e) => e.event === 'calendar_compositor_refused_external_executable');
    expect(errorLogs.length).toBeGreaterThan(0);
  });

  it('parses successful report correctly on exit 0', async () => {
    const fakeScript = createFakeSidecarScript(`
      const fs = require('fs');
      const args = process.argv;
      const reportIdx = args.indexOf('--report');
      const outIdx = args.indexOf('--output');
      const reportPath = args[reportIdx + 1];
      const outPath = args[outIdx + 1];

      fs.writeFileSync(outPath, 'fake-video-bytes');
      fs.writeFileSync(reportPath, JSON.stringify({
        applied: true,
        artworkSha256: 'a'.repeat(64),
        processedFrames: 90,
        visibleFrames: 90,
        trackingCoverage: 1.0,
        lowConfidenceFrames: 0,
        compositorVersion: '1.0.0'
      }));
      process.exit(0);
    `);

    // In tests, launch node as runner pointing to fakeScript inside sidecarDir
    const compositor = createCalendarCompositor({
      resourcesDir,
      tempDir,
      logger: mockLogger,
      _testSidecarExePath: fakeScript,
      _testSpawnOverride: (_cmd, args, opts) => {
        return spawn(process.execPath, [fakeScript, ...args], opts);
      },
    });

    const inputVideo = path.join(tempDir, 'input.mp4');
    const artwork = path.join(tempDir, 'art.png');
    const outputVideo = path.join(tempDir, 'output.mp4');
    fs.writeFileSync(inputVideo, 'input-bytes');
    fs.writeFileSync(artwork, 'art-bytes');

    const result = await compositor.process({
      inputVideoPath: inputVideo,
      artworkPath: artwork,
      outputVideoPath: outputVideo,
      sku: 'SKU-001',
      jobId: 'job-abc',
    });

    expect(result.applied).toBe(true);
    expect(result.visibleFrames).toBe(90);
    expect(result.trackingCoverage).toBe(1.0);
    expect(fs.existsSync(outputVideo)).toBe(true);
  });

  it('exit 3 -> CALENDAR_COMPOSITING_FAILED and deletes partial output', async () => {
    const fakeScript = createFakeSidecarScript(`
      const fs = require('fs');
      const args = process.argv;
      const reportIdx = args.indexOf('--report');
      const outIdx = args.indexOf('--output');
      const reportPath = args[reportIdx + 1];
      const outPath = args[outIdx + 1];

      // Create partial output that should be deleted
      fs.writeFileSync(outPath, 'partial-output-bytes');
      fs.writeFileSync(reportPath, JSON.stringify({
        applied: false,
        artworkSha256: 'b'.repeat(64),
        processedFrames: 60,
        visibleFrames: 10,
        trackingCoverage: 0.16,
        lowConfidenceFrames: 50,
        compositorVersion: '1.0.0'
      }));
      process.exit(3);
    `);

    const compositor = createCalendarCompositor({
      resourcesDir,
      tempDir,
      logger: mockLogger,
      _testSidecarExePath: fakeScript,
      _testSpawnOverride: (_cmd, args, opts) => {
        return spawn(process.execPath, [fakeScript, ...args], opts);
      },
    });

    const inputVideo = path.join(tempDir, 'input.mp4');
    const artwork = path.join(tempDir, 'art.png');
    const outputVideo = path.join(tempDir, 'output.mp4');
    fs.writeFileSync(inputVideo, 'input-bytes');
    fs.writeFileSync(artwork, 'art-bytes');

    await expect(
      compositor.process({
        inputVideoPath: inputVideo,
        artworkPath: artwork,
        outputVideoPath: outputVideo,
        sku: 'SKU-002',
        jobId: 'job-fail-3',
      })
    ).rejects.toThrowError(PodError);

    // Verify partial output is deleted
    expect(fs.existsSync(outputVideo)).toBe(false);
  });

  it('malformed report -> CALENDAR_COMPOSITING_FAILED and deletes partial output', async () => {
    const fakeScript = createFakeSidecarScript(`
      const fs = require('fs');
      const args = process.argv;
      const reportIdx = args.indexOf('--report');
      const outIdx = args.indexOf('--output');
      const reportPath = args[reportIdx + 1];
      const outPath = args[outIdx + 1];

      fs.writeFileSync(outPath, 'partial');
      fs.writeFileSync(reportPath, 'NOT-VALID-JSON');
      process.exit(0);
    `);

    const compositor = createCalendarCompositor({
      resourcesDir,
      tempDir,
      logger: mockLogger,
      _testSidecarExePath: fakeScript,
      _testSpawnOverride: (_cmd, args, opts) => {
        return spawn(process.execPath, [fakeScript, ...args], opts);
      },
    });

    const inputVideo = path.join(tempDir, 'input.mp4');
    const artwork = path.join(tempDir, 'art.png');
    const outputVideo = path.join(tempDir, 'output.mp4');
    fs.writeFileSync(inputVideo, 'input');
    fs.writeFileSync(artwork, 'art');

    await expect(
      compositor.process({
        inputVideoPath: inputVideo,
        artworkPath: artwork,
        outputVideoPath: outputVideo,
        sku: 'SKU-003',
        jobId: 'job-bad-report',
      })
    ).rejects.toThrowError(PodError);

    expect(fs.existsSync(outputVideo)).toBe(false);
  });

  it('times out and kills child process tree on slow execution', async () => {
    const fakeScript = createFakeSidecarScript(`
      const fs = require('fs');
      const args = process.argv;
      const outIdx = args.indexOf('--output');
      const outPath = args[outIdx + 1];
      fs.writeFileSync(outPath, 'partial-before-hang');

      // Hang indefinitely
      setInterval(() => {}, 1000);
    `);

    const compositor = createCalendarCompositor({
      resourcesDir,
      tempDir,
      logger: mockLogger,
      timeoutMs: 200, // Fast timeout for test
      _testSidecarExePath: fakeScript,
      _testSpawnOverride: (_cmd, args, opts) => {
        return spawn(process.execPath, [fakeScript, ...args], opts);
      },
    });

    const inputVideo = path.join(tempDir, 'input.mp4');
    const artwork = path.join(tempDir, 'art.png');
    const outputVideo = path.join(tempDir, 'output.mp4');
    fs.writeFileSync(inputVideo, 'input');
    fs.writeFileSync(artwork, 'art');

    await expect(
      compositor.process({
        inputVideoPath: inputVideo,
        artworkPath: artwork,
        outputVideoPath: outputVideo,
        sku: 'SKU-TIMEOUT',
        jobId: 'job-timeout',
      })
    ).rejects.toThrowError(PodError);

    expect(fs.existsSync(outputVideo)).toBe(false);
    compositor.dispose();
  });

  it('never logs absolute paths or image bytes in log fields', async () => {
    const fakeScript = createFakeSidecarScript(`
      const fs = require('fs');
      const args = process.argv;
      const reportIdx = args.indexOf('--report');
      const outIdx = args.indexOf('--output');
      const reportPath = args[reportIdx + 1];
      const outPath = args[outIdx + 1];

      fs.writeFileSync(outPath, 'video');
      fs.writeFileSync(reportPath, JSON.stringify({
        applied: true,
        artworkSha256: 'c'.repeat(64),
        processedFrames: 100,
        visibleFrames: 95,
        trackingCoverage: 0.95,
        lowConfidenceFrames: 5,
        compositorVersion: '1.0.0'
      }));
      process.exit(0);
    `);

    const compositor = createCalendarCompositor({
      resourcesDir,
      tempDir,
      logger: mockLogger,
      _testSidecarExePath: fakeScript,
      _testSpawnOverride: (_cmd, args, opts) => {
        return spawn(process.execPath, [fakeScript, ...args], opts);
      },
    });

    const inputVideo = path.join(tempDir, 'input.mp4');
    const artwork = path.join(tempDir, 'art.png');
    const outputVideo = path.join(tempDir, 'output.mp4');
    fs.writeFileSync(inputVideo, 'input');
    fs.writeFileSync(artwork, 'art');

    await compositor.process({
      inputVideoPath: inputVideo,
      artworkPath: artwork,
      outputVideoPath: outputVideo,
      sku: 'SKU-LOGS',
      jobId: 'job-safe-logs',
    });

    // Check all recorded log fields
    for (const entry of loggedEvents) {
      if (entry.fields) {
        for (const [_key, val] of Object.entries(entry.fields)) {
          if (typeof val === 'string') {
            // Must not contain Windows absolute path C:\ or Unix /
            expect(val).not.toMatch(/^[a-zA-Z]:\\/);
            expect(val).not.toMatch(/^\/[a-zA-Z]/);
          }
        }
      }
    }
  });

  it('integration: runs real built sidecar on fixture a if exists', async () => {
    const realBuiltExe = path.resolve('vendor/calendar-compositor/dist/calendar-compositor/calendar-compositor.exe');
    if (!fs.existsSync(realBuiltExe)) {
      return; // Skipped if sidecar not built yet
    }

    const realDistDir = path.dirname(realBuiltExe);
    const parentDir = path.dirname(realDistDir);

    const compositor = createCalendarCompositor({
      resourcesDir: parentDir,
      tempDir,
      logger: mockLogger,
      _testSidecarExePath: realBuiltExe,
      _testFfmpegExePath: path.join(realDistDir, 'ffmpeg.exe'),
      _testFfprobeExePath: path.join(realDistDir, 'ffprobe.exe'),
    });

    const fixtureA = path.resolve('tools/calendar-compositor/fixtures/fixture_a_static.mp4');
    const art = path.resolve('tools/calendar-compositor/fixtures/artwork.png');
    const out = path.join(tempDir, 'real_out_a.mp4');

    if (fs.existsSync(fixtureA) && fs.existsSync(art)) {
      const res = await compositor.process({
        inputVideoPath: fixtureA,
        artworkPath: art,
        outputVideoPath: out,
        sku: 'REAL-001',
        jobId: 'job-real',
      });
      expect(res.applied).toBe(true);
      expect(fs.existsSync(out)).toBe(true);
    }
  }, 60000);
});
