import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Job } from '@shared/domain';
import type { JobState } from '@shared/job-state';
import type { CalendarArtworkCompositor, PodDatabase } from '@shared/services';
import { ImageStagingService } from '../../src/main/app/image-staging';
import { JobOrchestrator } from '../../src/main/app/job-orchestrator';
import { createUnavailableCompositor } from '../../src/main/app/unavailable-compositor';
import { newId } from '../../src/main/domain/ids';
import { openDatabase } from '../../src/main/infra/db';
import { createLogger } from '../../src/main/infra/logging';
import { createMediaLibrary } from '../../src/main/infra/media';
import { createPromptService } from '../../src/main/prompts';
import { createMinimalValidMp4 } from '../../src/main/providers/muse/mp4';
import { RestBridgeMuseProvider } from '../../src/main/providers/muse/rest-bridge';
import { MockBridgeServer } from '../mock-bridge/server';

function buildPngBuffer(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 4, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.set([0x08, 0x02, 0x00, 0x00, 0x00], 24);
  buf.writeUInt32BE(0, 29);
  return buf;
}

async function waitForJobState(
  db: PodDatabase,
  jobId: string,
  targetState: JobState | JobState[],
  timeoutMs = 6000
): Promise<Job> {
  const targets = Array.isArray(targetState) ? targetState : [targetState];
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const job = db.jobs.getById(jobId);
    if (job && targets.includes(job.state)) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const finalJob = db.jobs.getById(jobId);
  throw new Error(`Timeout waiting for job state. Current state: ${finalJob?.state}`);
}

describe('Logs Security E2E', () => {
  let server: MockBridgeServer;
  let serverBaseUrl: string;
  let tempRoot: string;
  const SECRET_API_KEY = 'secret-top-security-key-987654321';
  const UNIQUE_PROMPT_SNIPPET =
    'ExtremelyUniquePromptPreserveArtworkNonPlasticTextureContinuityRealism999';

  beforeAll(async () => {
    server = new MockBridgeServer({ expectedToken: SECRET_API_KEY });
    serverBaseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    server.setExpectedToken(SECRET_API_KEY);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-logs-sec-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('logs written during the e2e run contain no prompt text and no API key', async () => {
    server.setBehavior('healthy');
    const logsDir = path.join(tempRoot, 'logs');
    const logger = createLogger({
      dir: logsDir,
      retentionDays: 30,
      level: 'debug',
    });

    const libraryRoot = path.join(tempRoot, 'library');
    const media = createMediaLibrary({
      root: libraryRoot,
      tempDir: path.join(libraryRoot, '.tmp'),
      maxSourceBytes: 15 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
    });

    const prompts = createPromptService({
      builtinDir: path.resolve('prompts'),
      adminDir: path.join(tempRoot, 'admin-prompts'),
      companyMasterPath: null,
    });

    const config: AppConfig = {
      providerMode: 'bridge',
      musePlatformOrigin: 'https://muse.ai',
      bridgeBaseUrl: serverBaseUrl,
      promptMasterPath: null,
      libraryRoot,
      dataDir: tempRoot,
      promptMaxChars: 4000,
      pollIntervalMs: 100,
      pollMaxIntervalMs: 250,
      maxSourceBytes: 15 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
      logRetentionDays: 30,
      adminUsers: ['admin'],
      categories: [{ id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' }],
      isDev: true,
    };

    const provider = new RestBridgeMuseProvider({
      config,
      getApiKey: () => SECRET_API_KEY,
      logger,
    });

    const imageStaging = new ImageStagingService();
    const db = openDatabase(path.join(tempRoot, 'test.db'));

    const orchestrator = new JobOrchestrator({
      db,
      media,
      prompts,
      provider,
      config,
      logger,
      imageStaging,
      compositor: createUnavailableCompositor(),
    });

    // Stage an image
    const imgPath = path.join(tempRoot, 'source.png');
    fs.writeFileSync(imgPath, buildPngBuffer(100, 100));
    const info = await media.validateImage(imgPath);
    const staged = imageStaging.stage(imgPath, info);

    // Create a job with an explicit prompt override containing the unique prompt snippet
    // (must satisfy quality rules: natural texture, physical continuity, preserve artwork, etc.)
    const fullPromptOverride = `
Human product review action where the reviewer presents and examines the product.
Preserve exact artwork and printed graphic ${UNIQUE_PROMPT_SNIPPET}.
Do not alter or change the artwork.
Consistent product construction throughout.
Ensure natural, non-plastic textures for hands and materials; avoid plastic look.
Physically continuous movement with gravity.
No impossible transitions or teleporting.
No fake claims or ratings.
`;

    const view = await orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: staged.token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-SEC01',
        categoryId: 't-shirt',
        promptOverride: fullPromptOverride,
      },
      'employee-audit'
    );

    // Wait until SUCCEEDED
    await waitForJobState(db, view.job.id, 'SUCCEEDED', 8000);
    orchestrator.stop();

    // Flush all log writes to disk
    await logger.flush();

    // Read all log files produced
    const logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    expect(logFiles.length).toBeGreaterThan(0);

    let allLogContent = '';
    for (const f of logFiles) {
      allLogContent += fs.readFileSync(path.join(logsDir, f), 'utf-8') + '\n';
    }

    // 1. API key must NEVER appear in the logs
    expect(allLogContent).not.toContain(SECRET_API_KEY);

    // 2. Prompt text must NEVER appear in the logs
    expect(allLogContent).not.toContain(UNIQUE_PROMPT_SNIPPET);
    expect(allLogContent).not.toContain('Authentic human product review');
    expect(allLogContent).not.toContain('Preserve the artwork');

    // 3. No absolute paths
    expect(allLogContent).not.toContain(tempRoot);
    expect(allLogContent).not.toContain(libraryRoot);

    db.close();
  });

  it('calendar logs contain no prompt text, no API key, no image bytes, and no absolute paths', async () => {
    server.setBehavior('healthy');
    const logsDir = path.join(tempRoot, 'logs-cal');
    const logger = createLogger({
      dir: logsDir,
      retentionDays: 30,
      level: 'debug',
    });

    const libraryRoot = path.join(tempRoot, 'library-cal');
    const media = createMediaLibrary({
      root: libraryRoot,
      tempDir: path.join(libraryRoot, '.tmp'),
      maxSourceBytes: 15 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
    });

    const prompts = createPromptService({
      builtinDir: path.resolve('prompts'),
      adminDir: path.join(tempRoot, 'admin-prompts'),
      companyMasterPath: null,
    });

    const config: AppConfig = {
      providerMode: 'bridge',
      musePlatformOrigin: 'https://muse.ai',
      bridgeBaseUrl: serverBaseUrl,
      promptMasterPath: null,
      libraryRoot,
      dataDir: tempRoot,
      promptMaxChars: 4000,
      pollIntervalMs: 100,
      pollMaxIntervalMs: 250,
      maxSourceBytes: 15 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
      logRetentionDays: 30,
      adminUsers: ['admin'],
      categories: [
        { id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' },
      ],
      isDev: true,
    };

    const provider = new RestBridgeMuseProvider({
      config,
      getApiKey: () => SECRET_API_KEY,
      logger,
    });

    const imageStaging = new ImageStagingService();
    const db = openDatabase(path.join(tempRoot, 'test-cal.db'));

    const mockCompositor: CalendarArtworkCompositor = {
      process: async (input) => {
        fs.writeFileSync(input.outputVideoPath, createMinimalValidMp4());
        return {
          applied: true,
          artworkSha256: 'mock-sha-256',
          processedFrames: 60,
          visibleFrames: 50,
          trackingCoverage: 0.83,
          lowConfidenceFrames: 1,
          compositorVersion: '1.0.0-test',
        };
      },
    };

    const orchestrator = new JobOrchestrator({
      db,
      media,
      prompts,
      provider,
      config,
      logger,
      imageStaging,
      compositor: mockCompositor,
    });

    // Stage front cover and interior artwork
    const frontPath = path.join(tempRoot, 'cover.png');
    fs.writeFileSync(frontPath, buildPngBuffer(100, 100));
    const frontInfo = await media.validateImage(frontPath);
    const frontStaged = imageStaging.stage(frontPath, frontInfo);

    const artMarker = 'INTERIOR_ARTWORK_RAW_BYTES_MARKER_999';
    const artPath = path.join(tempRoot, 'art.png');
    fs.writeFileSync(artPath, buildPngBuffer(100, 100));
    const artInfo = await media.validateImage(artPath);
    const artStaged = imageStaging.stage(artPath, artInfo);

    const UNIQUE_CAL_SNIPPET = 'UniqueCalendarReviewPromptMarker777';
    const calPromptOverride = `
Human product review action where the reviewer presents and examines the desk calendar.
Preserve exact artwork and printed graphic ${UNIQUE_CAL_SNIPPET}.
Do not alter or change the artwork.
Consistent product construction throughout.
Ensure natural, non-plastic textures for hands and materials; avoid plastic look.
Physically continuous movement with gravity.
No impossible transitions or teleporting.
No fake claims or ratings.
The interior page must be a clean, warm-cream, matte blank paper surface.
`;

    const view = await orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: frontStaged.token,
        interiorArtworkToken: artStaged.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-SEC01',
        categoryId: 'desk-calendar',
        promptOverride: calPromptOverride,
      },
      'employee-audit'
    );

    await waitForJobState(db, view.job.id, 'SUCCEEDED', 8000);
    orchestrator.stop();

    await logger.flush();

    const logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    expect(logFiles.length).toBeGreaterThan(0);

    let allLogContent = '';
    for (const f of logFiles) {
      allLogContent += fs.readFileSync(path.join(logsDir, f), 'utf-8') + '\n';
    }

    // 1. API key must NEVER appear in the logs
    expect(allLogContent).not.toContain(SECRET_API_KEY);

    // 2. Prompt text must NEVER appear in the logs
    expect(allLogContent).not.toContain(UNIQUE_CAL_SNIPPET);
    expect(allLogContent).not.toContain('warm-cream');
    expect(allLogContent).not.toContain('spiral-bound desk calendar');

    // 3. No image bytes / markers
    expect(allLogContent).not.toContain(artMarker);

    // 4. No absolute paths in logs
    expect(allLogContent).not.toContain(tempRoot);
    expect(allLogContent).not.toContain(libraryRoot);
    expect(allLogContent).not.toContain(frontPath);
    expect(allLogContent).not.toContain(artPath);

    db.close();
  });
});
