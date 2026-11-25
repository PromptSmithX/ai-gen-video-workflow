import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Job } from '@shared/domain';
import { PodError } from '@shared/errors';
import type { JobState } from '@shared/job-state';
import type {
  CalendarArtworkCompositor,
  CalendarCompositionInput,
  CalendarCompositionReport,
  Logger,
  LogFields,
  MediaLibrary,
  PodDatabase,
  PromptService,
} from '@shared/services';
import { ImageStagingService } from '../../src/main/app/image-staging';
import { JobOrchestrator } from '../../src/main/app/job-orchestrator';
import { newId } from '../../src/main/domain/ids';
import { openDatabase } from '../../src/main/infra/db';
import { hashFile } from '../../src/main/infra/media/hash';
import { createMediaLibrary } from '../../src/main/infra/media';
import { createPromptService } from '../../src/main/prompts';
import { createMinimalValidMp4 } from '../../src/main/providers/muse/mp4';
import { RestBridgeMuseProvider } from '../../src/main/providers/muse/rest-bridge';
import { MockBridgeServer } from '../mock-bridge/server';

function buildPngBuffer(width = 100, height = 100, tag = 0): Buffer {
  const buf = Buffer.alloc(33 + 8);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 4, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.set([0x08, 0x02, 0x00, 0x00, 0x00], 24);
  buf.writeUInt32BE(0, 29);
  buf.writeUInt32BE(tag, 33);
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
  throw new Error(
    `Timeout waiting for job ${jobId} to reach state(s) [${targets.join(', ')}]. Current state: ${finalJob?.state}`
  );
}

describe('Calendar Job Orchestrator E2E', () => {
  let server: MockBridgeServer;
  let serverBaseUrl: string;
  let tempRoot: string;
  const testApiKey = 'test-token-cal-e2e';

  const capturedLogs: Array<{ level: string; event: string; fields?: LogFields }> = [];
  const testLogger: Logger = {
    debug: (event, fields) => capturedLogs.push({ level: 'debug', event, fields }),
    info: (event, fields) => capturedLogs.push({ level: 'info', event, fields }),
    warn: (event, fields) => capturedLogs.push({ level: 'warn', event, fields }),
    error: (event, fields) => capturedLogs.push({ level: 'error', event, fields }),
    child: () => testLogger,
  };

  beforeAll(async () => {
    server = new MockBridgeServer({ expectedToken: testApiKey });
    serverBaseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    server.setExpectedToken(testApiKey);
    capturedLogs.length = 0;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-cal-e2e-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  interface TestStack {
    db: PodDatabase;
    media: MediaLibrary;
    prompts: PromptService;
    imageStaging: ImageStagingService;
    orchestrator: JobOrchestrator;
    provider: RestBridgeMuseProvider;
    config: AppConfig;
    compositor: CalendarArtworkCompositor;
    stageImage: (name: string, width?: number, height?: number, tag?: number) => Promise<{ token: string; absPath: string }>;
  }

  function createTestStack(opts?: {
    compositor?: CalendarArtworkCompositor;
  }): TestStack {
    const db = openDatabase(path.join(tempRoot, 'test.db'));
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
      pollIntervalMs: 80,
      pollMaxIntervalMs: 200,
      maxSourceBytes: 15 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
      logRetentionDays: 30,
      adminUsers: ['admin'],
      categories: [
        { id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' },
        { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' },
      ],
      isDev: true,
    };

    const provider = new RestBridgeMuseProvider({
      config,
      getApiKey: () => testApiKey,
      logger: testLogger,
    });

    const imageStaging = new ImageStagingService();

    const defaultCompositor: CalendarArtworkCompositor = {
      process: async (input: CalendarCompositionInput): Promise<CalendarCompositionReport> => {
        fs.writeFileSync(input.outputVideoPath, createMinimalValidMp4());
        return {
          applied: true,
          artworkSha256: await hashFile(input.artworkPath),
          processedFrames: 120,
          visibleFrames: 100,
          trackingCoverage: 0.85,
          lowConfidenceFrames: 2,
          compositorVersion: '0.1.0-test',
        };
      },
    };

    const compositor = opts?.compositor ?? defaultCompositor;

    const orchestrator = new JobOrchestrator({
      db,
      media,
      prompts,
      provider,
      config,
      logger: testLogger,
      imageStaging,
      compositor,
    });

    const stageImage = async (name: string, width = 100, height = 100, tag = 0) => {
      const imgPath = path.join(tempRoot, name);
      fs.writeFileSync(imgPath, buildPngBuffer(width, height, tag));
      const info = await media.validateImage(imgPath);
      const staged = imageStaging.stage(imgPath, info);
      return { token: staged.token, absPath: imgPath };
    };

    return {
      db,
      media,
      prompts,
      imageStaging,
      orchestrator,
      provider,
      config,
      compositor,
      stageImage,
    };
  }

  // 1. Calendar create: one source_image + one job-linked interior_artwork asset; files byte-identical; idempotent
  it('Calendar create: one source_image + one job-linked interior_artwork asset, byte-identical, idempotent repeat', async () => {
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 111);
    const artwork = await stack.stageImage('art.png', 120, 120, 222);

    const clientRequestId = newId();
    const view = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-001',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    expect(view.job.id).toBeDefined();
    expect(view.category).toBe('desk-calendar');
    expect(view.interiorArtworkUrl).toMatch(/^pod-media:\/\/asset\//);

    // Verify assets in DB
    const jobAssets = stack.db.assets.listByJob(view.job.id);
    const artAsset = jobAssets.find((a) => a.role === 'interior_artwork');
    expect(artAsset).toBeDefined();
    expect(artAsset?.jobId).toBe(view.job.id);
    expect(artAsset?.role).toBe('interior_artwork');

    const sourceAsset = stack.db.assets.getById(view.job.sourceAssetId);
    expect(sourceAsset).toBeDefined();
    expect(sourceAsset?.role).toBe('source_image');

    // Verify files on disk are byte-identical
    const coverOriginalBytes = fs.readFileSync(cover.absPath);
    const coverStoredBytes = fs.readFileSync(stack.media.resolve(sourceAsset!.path));
    expect(coverStoredBytes.equals(coverOriginalBytes)).toBe(true);

    const artworkOriginalBytes = fs.readFileSync(artwork.absPath);
    const artworkStoredBytes = fs.readFileSync(stack.media.resolve(artAsset!.path));
    expect(artworkStoredBytes.equals(artworkOriginalBytes)).toBe(true);

    // Idempotent repeat: same clientRequestId creates no duplicate files/rows
    const initialFiles = fs.readdirSync(path.join(stack.config.libraryRoot, 'CAL-001', 'source'));
    const initialAssetCount = stack.db.assets.listByJob(view.job.id).length;

    const repeatView = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-001',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    expect(repeatView.job.id).toBe(view.job.id);
    const afterFiles = fs.readdirSync(path.join(stack.config.libraryRoot, 'CAL-001', 'source'));
    expect(afterFiles.length).toBe(initialFiles.length);
    expect(stack.db.assets.listByJob(view.job.id).length).toBe(initialAssetCount);

    stack.orchestrator.stop();
    stack.db.close();
  });

  // 2. Missing artwork token -> error, no provider call, no files left
  it('Calendar create: missing artwork token -> error, no provider call, no files left', async () => {
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 111);

    await expect(
      stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: cover.token,
          // interiorArtworkToken omitted!
          templateId: 'calendar-review',
          templateVersion: 'v1',
          sku: 'CAL-NOART',
          categoryId: 'desk-calendar',
        },
        'employee-1'
      )
    ).rejects.toThrow('Interior artwork is required for Desk Calendar');

    expect(stack.db.jobs.list().length).toBe(0);
    expect(fs.existsSync(path.join(stack.config.libraryRoot, 'CAL-NOART'))).toBe(false);
    expect(server.getRequests().length).toBe(0);

    stack.orchestrator.stop();
    stack.db.close();
  });

  // 3. DB transaction failure -> all new files removed
  it('Calendar create: DB transaction failure -> all new files removed', async () => {
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 111);
    const artwork = await stack.stageImage('art.png', 120, 120, 222);

    // Spy/force db.transaction to throw
    const originalTx = stack.db.transaction.bind(stack.db);
    stack.db.transaction = () => {
      throw new Error('Simulated DB failure during job creation');
    };

    await expect(
      stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: cover.token,
          interiorArtworkToken: artwork.token,
          templateId: 'calendar-review',
          templateVersion: 'v1',
          sku: 'CAL-DBFAIL',
          categoryId: 'desk-calendar',
        },
        'employee-1'
      )
    ).rejects.toThrow('Simulated DB failure during job creation');

    // All created source/artwork/prompt files must be deleted
    const sourceDir = path.join(stack.config.libraryRoot, 'CAL-DBFAIL', 'source');
    if (fs.existsSync(sourceDir)) {
      expect(fs.readdirSync(sourceDir).length).toBe(0);
    }
    const promptsDir = path.join(stack.config.libraryRoot, 'CAL-DBFAIL', 'prompts');
    if (fs.existsSync(promptsDir)) {
      expect(fs.readdirSync(promptsDir).length).toBe(0);
    }

    stack.db.transaction = originalTx;
    stack.orchestrator.stop();
    stack.db.close();
  });

  // 4. Non-calendar with a stale interiorArtworkToken -> no artwork asset, behaviour identical
  it('Non-calendar with a stale interiorArtworkToken -> no artwork asset, identical apparel behaviour', async () => {
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 111);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: 'stale-token-from-previous-state',
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-STALE',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    expect(view.job.id).toBeDefined();
    expect(view.category).toBe('t-shirt');
    expect(view.interiorArtworkUrl).toBeNull();

    const assets = stack.db.assets.listByJob(view.job.id);
    const artAsset = assets.find((a) => a.role === 'interior_artwork');
    expect(artAsset).toBeUndefined();

    // Wait until SUCCEEDED so the worker loop settles before next test
    await waitForJobState(stack.db, view.job.id, 'SUCCEEDED', 8000);
    stack.orchestrator.stop();
    stack.db.close();
  });

  // 5. Provider boundary: calendar job submits exactly one reference = front cover bytes; artwork never appears in provider calls
  it('Provider boundary: calendar job submits exactly one reference = front cover bytes; artwork never sent to bridge', async () => {
    server.reset();
    server.setExpectedToken(testApiKey);
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 333);
    const artwork = await stack.stageImage('art.png', 120, 120, 444);

    const coverBytes = fs.readFileSync(cover.absPath);
    const artworkBytes = fs.readFileSync(artwork.absPath);
    const artworkSha = await hashFile(artwork.absPath);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-PROV01',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    await waitForJobState(stack.db, view.job.id, 'SUCCEEDED', 8000);
    stack.orchestrator.stop();

    const requests = server.getRequests();
    // Verify reference uploads: exactly one reference upload and it matches front cover bytes
    const refUploads = requests.filter((r) => r.method === 'POST' && r.url === '/v1/references');
    expect(refUploads.length).toBe(1);
    expect(refUploads[0]!.rawBody.equals(coverBytes)).toBe(true);

    // Verify that artwork bytes and artwork sha256 NEVER appear in ANY request
    for (const req of requests) {
      expect(req.rawBody.includes(artworkBytes)).toBe(false);
      expect(req.url).not.toContain(artworkSha);
      if (req.rawBody.length > 0) {
        expect(req.rawBody.toString('utf-8')).not.toContain(artworkSha);
      }
    }

    stack.db.close();
  });

  // 6. Download: non-calendar never calls compositor
  it('Download: non-calendar job never calls compositor', async () => {
    let compositorCallCount = 0;
    const testCompositor: CalendarArtworkCompositor = {
      process: async () => {
        compositorCallCount++;
        throw new Error('Compositor should not have been called');
      },
    };

    const stack = createTestStack({ compositor: testCompositor });
    const cover = await stack.stageImage('cover.png', 100, 100, 555);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-NOCOMP',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    await waitForJobState(stack.db, view.job.id, 'SUCCEEDED', 8000);
    stack.orchestrator.stop();

    expect(compositorCallCount).toBe(0);
    stack.db.close();
  });

  // 7. Download: calendar calls compositor with persisted artwork path and stores processed video with calendarPostProcess metadata
  it('Download: calendar calls compositor with persisted artwork path and stores processed video + metadata', async () => {
    let capturedInput: CalendarCompositionInput | null = null;
    const testCompositor: CalendarArtworkCompositor = {
      process: async (input) => {
        capturedInput = input;
        fs.writeFileSync(input.outputVideoPath, createMinimalValidMp4());
        return {
          applied: true,
          artworkSha256: await hashFile(input.artworkPath),
          processedFrames: 150,
          visibleFrames: 130,
          trackingCoverage: 0.87,
          lowConfidenceFrames: 3,
          compositorVersion: '2.5.0-cal',
        };
      },
    };

    const stack = createTestStack({ compositor: testCompositor });
    const cover = await stack.stageImage('cover.png', 100, 100, 777);
    const artwork = await stack.stageImage('art.png', 120, 120, 888);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-METADATA',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    await waitForJobState(stack.db, view.job.id, 'SUCCEEDED', 8000);
    stack.orchestrator.stop();

    expect(capturedInput).not.toBeNull();
    // Compositor was called with the persisted interior artwork path
    const artAsset = stack.db.assets.listByJob(view.job.id).find((a) => a.role === 'interior_artwork');
    expect(artAsset).toBeDefined();
    expect(capturedInput!.artworkPath).toBe(stack.media.resolve(artAsset!.path));
    expect(fs.existsSync(capturedInput!.artworkPath)).toBe(true);

    // Stored video asset exists
    const videoAsset = stack.db.assets.listByJob(view.job.id).find((a) => a.role === 'generated_video');
    expect(videoAsset).toBeDefined();

    // Verify metadata json
    const metadataDir = path.join(stack.config.libraryRoot, 'CAL-METADATA', 'metadata');
    const metadataFiles = fs.readdirSync(metadataDir).filter((f) => f.endsWith('.json'));
    expect(metadataFiles.length).toBe(1);
    const metadataFile = metadataFiles[0]!;

    const metadataContent = JSON.parse(fs.readFileSync(path.join(metadataDir, metadataFile), 'utf-8'));
    expect(metadataContent.calendarPostProcess).toBeDefined();
    expect(metadataContent.calendarPostProcess.applied).toBe(true);
    expect(metadataContent.calendarPostProcess.compositorVersion).toBe('2.5.0-cal');
    expect(metadataContent.calendarPostProcess.trackingCoverage).toBe(0.87);
    expect(metadataContent.calendarPostProcess.processedFrames).toBe(150);
    expect(metadataContent.calendarPostProcess.visibleFrames).toBe(130);
    expect(metadataContent.calendarPostProcess.lowConfidenceFrames).toBe(3);
    expect(metadataContent.calendarPostProcess.interiorArtworkSha256).toBe(artAsset?.sha256);

    stack.db.close();
  });

  // 8. Download: compositor throws -> DOWNLOAD_FAILED + CALENDAR_COMPOSITING_FAILED, no generated_video asset, retryDownload re-runs download + compositor with generateVideo count staying 1
  it('Download: compositor throws -> DOWNLOAD_FAILED, no asset, temp cleaned; retryDownload succeeds with 1 generateVideo submit', async () => {
    let failCompositor = true;
    let compositorCallCount = 0;
    const testCompositor: CalendarArtworkCompositor = {
      process: async (input) => {
        compositorCallCount++;
        if (failCompositor) {
          throw new PodError('CALENDAR_COMPOSITING_FAILED', 'Simulated compositor tracking failure');
        }
        fs.writeFileSync(input.outputVideoPath, createMinimalValidMp4());
        return {
          applied: true,
          artworkSha256: await hashFile(input.artworkPath),
          processedFrames: 100,
          visibleFrames: 80,
          trackingCoverage: 0.8,
          lowConfidenceFrames: 1,
          compositorVersion: '1.0.0-retry',
        };
      },
    };

    const stack = createTestStack({ compositor: testCompositor });
    const cover = await stack.stageImage('cover.png', 100, 100, 101);
    const artwork = await stack.stageImage('art.png', 120, 120, 102);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-FAILRETRY',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    // Wait until DOWNLOAD_FAILED
    const failedJob = await waitForJobState(stack.db, view.job.id, 'DOWNLOAD_FAILED', 8000);
    expect(failedJob.errorCode).toBe('CALENDAR_COMPOSITING_FAILED');
    expect(failedJob.providerJobId).toBeDefined();

    // No generated_video asset
    const videoAsset = stack.db.assets.listByJob(view.job.id).find((a) => a.role === 'generated_video');
    expect(videoAsset).toBeUndefined();

    // Verify temp files cleaned up
    const tempDir = path.join(stack.config.libraryRoot, '.tmp');
    const remainingTemp = fs.readdirSync(tempDir);
    expect(remainingTemp.length).toBe(0);

    // Now fix compositor and retry download
    failCompositor = false;
    const preRetryPostCount = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length;
    expect(preRetryPostCount).toBe(1);

    await stack.orchestrator.retryDownload(view.job.id);
    await waitForJobState(stack.db, view.job.id, 'SUCCEEDED', 8000);
    stack.orchestrator.stop();

    // generateVideo call count stays 1!
    const postRetryPostCount = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length;
    expect(postRetryPostCount).toBe(1);

    // Compositor was called twice (first failed, second succeeded)
    expect(compositorCallCount).toBe(2);

    // Now generated_video asset exists
    const finalVideo = stack.db.assets.listByJob(view.job.id).find((a) => a.role === 'generated_video');
    expect(finalVideo).toBeDefined();

    stack.db.close();
  });

  // 9. Download: artwork hash mismatch -> DOWNLOAD_FAILED, compositor not called
  it('Download: artwork hash mismatch -> failure, compositor not called', async () => {
    let compositorCalled = false;
    const testCompositor: CalendarArtworkCompositor = {
      process: async () => {
        compositorCalled = true;
        throw new Error('Compositor must not be called when hash mismatches');
      },
    };

    const stack = createTestStack({ compositor: testCompositor });
    const cover = await stack.stageImage('cover.png', 100, 100, 201);
    const artwork = await stack.stageImage('art.png', 120, 120, 202);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-HASHMISMATCH',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    // Wait until RUNNING so files are already imported
    await waitForJobState(stack.db, view.job.id, ['RUNNING', 'DOWNLOADING'], 8000);

    // Corrupt the interior artwork file on disk before download post-processing checks hash
    const artAsset = stack.db.assets.listByJob(view.job.id).find((a) => a.role === 'interior_artwork');
    expect(artAsset).toBeDefined();
    const artworkAbsPath = stack.media.resolve(artAsset!.path);
    fs.appendFileSync(artworkAbsPath, Buffer.from('corrupting-bytes'));

    // Wait for transition to DOWNLOAD_FAILED
    const failedJob = await waitForJobState(stack.db, view.job.id, 'DOWNLOAD_FAILED', 8000);
    stack.orchestrator.stop();

    expect(failedJob.errorCode).toBe('CALENDAR_COMPOSITING_FAILED');
    expect(compositorCalled).toBe(false);

    stack.db.close();
  });

  // 10. Regenerate calendar job -> new job has its own interior_artwork row with same path/hash; missing artwork -> refused
  it('Regenerate calendar job: new job has own interior_artwork row with same path/hash; missing artwork refused', async () => {
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 301);
    const artwork = await stack.stageImage('art.png', 120, 120, 302);

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-REGEN',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    const initialJob = await waitForJobState(stack.db, view.job.id, 'SUCCEEDED', 8000);
    const originalArtAsset = stack.db.assets.listByJob(initialJob.id).find((a) => a.role === 'interior_artwork');
    expect(originalArtAsset).toBeDefined();

    // Regenerate
    const newClientReqId = newId();
    const regenView = await stack.orchestrator.regenerate(initialJob.id, true, newClientReqId);
    expect(regenView.job.id).not.toBe(initialJob.id);
    expect(regenView.job.regeneratedFromJobId).toBe(initialJob.id);
    expect(regenView.interiorArtworkUrl).toMatch(/^pod-media:\/\/asset\//);

    // New job has its own interior_artwork row with same path and sha256
    const regenAssets = stack.db.assets.listByJob(regenView.job.id);
    const regenArtAsset = regenAssets.find((a) => a.role === 'interior_artwork');
    expect(regenArtAsset).toBeDefined();
    expect(regenArtAsset!.id).not.toBe(originalArtAsset!.id);
    expect(regenArtAsset!.path).toBe(originalArtAsset!.path);
    expect(regenArtAsset!.sha256).toBe(originalArtAsset!.sha256);

    // Now test missing artwork refusal: delete artwork file
    const artAbsPath = stack.media.resolve(originalArtAsset!.path);
    fs.unlinkSync(artAbsPath);

    await expect(
      stack.orchestrator.regenerate(initialJob.id, true, newId())
    ).rejects.toThrow();

    stack.orchestrator.stop();
    stack.db.close();
  });

  // 11. JobView.interiorArtworkUrl set for calendar, null for apparel; no absolute paths in any JobView
  it('JobView: interiorArtworkUrl set for calendar, null for apparel; no absolute paths anywhere in JobView', async () => {
    const stack = createTestStack();
    const cover = await stack.stageImage('cover.png', 100, 100, 401);
    const artwork = await stack.stageImage('art.png', 120, 120, 402);

    // Calendar job
    const calView = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: artwork.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'CAL-VIEW',
        categoryId: 'desk-calendar',
      },
      'employee-1'
    );

    expect(calView.interiorArtworkUrl).toMatch(/^pod-media:\/\/asset\//);

    // Apparel job
    const apparelCover = await stack.stageImage('tshirt.png', 100, 100, 403);
    const apparelView = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: apparelCover.token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-VIEW',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    expect(apparelView.interiorArtworkUrl).toBeNull();

    // Verify NO absolute paths in any property of JobView for both
    const checkNoAbsPaths = (obj: unknown, prefix = ''): void => {
      if (typeof obj === 'string') {
        expect(obj).not.toContain(tempRoot);
        expect(obj).not.toContain(':\\');
        expect(obj).not.toMatch(/^\/[a-zA-Z]/);
      } else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          checkNoAbsPaths(v, `${prefix}.${k}`);
        }
      }
    };

    checkNoAbsPaths(calView);
    checkNoAbsPaths(apparelView);

    stack.orchestrator.stop();
    stack.db.close();
  });
});
