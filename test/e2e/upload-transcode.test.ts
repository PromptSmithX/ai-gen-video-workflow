import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Job } from '@shared/domain';
import type { JobState } from '@shared/job-state';
import type { GenerateVideoInput, MuseProvider, ProviderJob } from '@shared/provider';
import type { Logger, LogFields, PodDatabase } from '@shared/services';
import { ImageStagingService } from '../../src/main/app/image-staging';
import { JobOrchestrator, providerRequestId } from '../../src/main/app/job-orchestrator';
import { createUnavailableCompositor } from '../../src/main/app/unavailable-compositor';
import { newId } from '../../src/main/domain/ids';
import { openDatabase } from '../../src/main/infra/db';
import { createMediaLibrary } from '../../src/main/infra/media';
import type { UploadImageEncoder } from '../../src/main/infra/media/upload-image';
import { createPromptService } from '../../src/main/prompts';

/** Valid PNG header followed by `padding` filler bytes (header validation only reads IHDR). */
function pngWithPadding(padding: number, tag = 0): Buffer {
  const buf = Buffer.alloc(41 + padding, 0);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 4, 'ascii');
  buf.writeUInt32BE(100, 16);
  buf.writeUInt32BE(100, 20);
  buf.set([0x08, 0x02, 0x00, 0x00, 0x00], 24);
  buf.writeUInt32BE(tag, 33);
  return buf;
}

const SMALL_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

async function waitForJob(db: PodDatabase, jobId: string, states: JobState[], timeoutMs = 5000): Promise<Job> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = db.jobs.getById(jobId);
    if (job && states.includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout; state=${db.jobs.getById(jobId)?.state}`);
}

describe('Front cover upload transcode', () => {
  let tempRoot: string;
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: (event, fields) => logs.push({ event, fields }),
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
    error: (event, fields) => logs.push({ event, fields }),
    child: () => logger,
  };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-upload-e2e-'));
    logs.length = 0;
  });
  afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  function setup(opts: { maxUploadBytes: number; encoder?: UploadImageEncoder; failFirstSubmit?: boolean }) {
    const db = openDatabase(path.join(tempRoot, 'test.db'));
    const libraryRoot = path.join(tempRoot, 'library');
    const media = createMediaLibrary({
      root: libraryRoot,
      tempDir: path.join(libraryRoot, '.tmp'),
      maxSourceBytes: 50 * 1024 * 1024,
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
      bridgeBaseUrl: 'http://127.0.0.1:1',
      promptMasterPath: null,
      libraryRoot,
      dataDir: tempRoot,
      promptMaxChars: 4000,
      pollIntervalMs: 50,
      pollMaxIntervalMs: 100,
      maxSourceBytes: 50 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
      logRetentionDays: 30,
      adminUsers: ['admin'],
      categories: [
        { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' },
        { id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' },
      ],
      isDev: true,
    };

    const calls: Array<{ input: GenerateVideoInput; bytes: Buffer }> = [];
    const provider: MuseProvider = {
      kind: 'bridge',
      getConnectionState: async () => 'ready',
      getCapabilities: async () => ({
        canCancel: false,
        reportsProgress: false,
        supportedDurations: [],
        supportedAspectRatios: [],
        maxPromptChars: 4000,
        maxUploadBytes: opts.maxUploadBytes,
      }),
      generateVideo: async (input): Promise<ProviderJob> => {
        calls.push({ input, bytes: fs.readFileSync(input.sourceImagePath) });
        if (opts.failFirstSubmit && calls.length === 1) {
          return { providerJobId: 'p-failed', state: 'failed', errorCode: 'NOT_CONNECTED', safeMessage: 'not received' };
        }
        return { providerJobId: `p-${calls.length}`, state: 'queued' };
      },
      getJob: async (id) => ({ providerJobId: id, state: 'running' }),
      downloadOutput: async () => {
        throw new Error('not used');
      },
    };

    const imageStaging = new ImageStagingService();
    const orchestrator = new JobOrchestrator({
      db,
      media,
      prompts,
      provider,
      config,
      logger,
      imageStaging,
      compositor: createUnavailableCompositor(),
      imageEncoder: opts.encoder,
    });

    const stage = async (name: string, padding: number, tag = 0) => {
      const p = path.join(tempRoot, name);
      fs.writeFileSync(p, pngWithPadding(padding, tag));
      const info = await media.validateImage(p);
      return { token: imageStaging.stage(p, info).token, absPath: p };
    };

    return { db, media, orchestrator, calls, stage, tempDir: path.join(libraryRoot, '.tmp') };
  }

  const encoder: UploadImageEncoder = {
    encodeJpeg: async () => ({ data: SMALL_JPEG, width: 100, height: 100 }),
  };

  it('oversized front cover: provider gets a JPEG within the limit, library original unchanged, temp removed', async () => {
    const s = setup({ maxUploadBytes: 1000, encoder });
    const cover = await s.stage('cover.png', 5000, 1);
    const art = await s.stage('art.png', 5000, 2);
    const view = await s.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        interiorArtworkToken: art.token,
        templateId: 'calendar-review',
        templateVersion: 'v1',
        sku: 'BIG-1',
        categoryId: 'desk-calendar',
      },
      'emp'
    );
    await waitForJob(s.db, view.job.id, ['RUNNING']);

    expect(s.calls).toHaveLength(1);
    const call = s.calls[0]!;
    expect(call.bytes.equals(SMALL_JPEG)).toBe(true);
    expect(call.input.sourceFileName).toMatch(/\.jpg$/);
    // Artwork never reaches the provider
    expect(call.bytes.equals(fs.readFileSync(art.absPath))).toBe(false);

    const source = s.db.assets.getById(view.job.sourceAssetId)!;
    expect(fs.readFileSync(s.media.resolve(source.path)).equals(fs.readFileSync(cover.absPath))).toBe(true);
    expect(fs.existsSync(call.input.sourceImagePath)).toBe(false);

    const ev = logs.find((l) => l.event === 'source_image_transcoded');
    expect(ev?.fields).toMatchObject({ originalBytes: 5041, uploadBytes: SMALL_JPEG.length });
    expect(JSON.stringify(ev?.fields)).not.toContain(tempRoot);

    s.orchestrator.stop();
    s.db.close();
  });

  it('front cover within the limit: provider gets the library original path (no transcode)', async () => {
    const s = setup({ maxUploadBytes: 20 * 1024 * 1024, encoder });
    const cover = await s.stage('cover.png', 100);
    const view = await s.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        templateId: 'product-review',
        templateVersion: 'v1',
        sku: 'SMALL-1',
        categoryId: 't-shirt',
      },
      'emp'
    );
    await waitForJob(s.db, view.job.id, ['RUNNING']);
    const source = s.db.assets.getById(view.job.sourceAssetId)!;
    expect(s.calls[0]!.input.sourceImagePath).toBe(s.media.resolve(source.path));
    expect(s.calls[0]!.input.sourceFileName).toBe(path.basename(source.path));
    expect(logs.some((l) => l.event === 'source_image_transcoded')).toBe(false);
    s.orchestrator.stop();
    s.db.close();
  });

  it('cannot fit even after compression: FAILED_RETRYABLE IMAGE_TOO_LARGE, provider never called', async () => {
    const big: UploadImageEncoder = {
      encodeJpeg: async () => ({ data: Buffer.alloc(5000, 1), width: 100, height: 100 }),
    };
    const s = setup({ maxUploadBytes: 1000, encoder: big });
    const cover = await s.stage('cover.png', 5000);
    const view = await s.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: cover.token,
        templateId: 'product-review',
        templateVersion: 'v1',
        sku: 'BIG-2',
        categoryId: 't-shirt',
      },
      'emp'
    );
    const job = await waitForJob(s.db, view.job.id, ['FAILED_RETRYABLE']);
    expect(job.errorCode).toBe('IMAGE_TOO_LARGE');
    expect(s.calls).toHaveLength(0);
    const leftovers = fs.existsSync(s.tempDir) ? fs.readdirSync(s.tempDir) : [];
    expect(leftovers).toEqual([]);
    s.orchestrator.stop();
    s.db.close();
  });

  it('retry after a provider failure sends a new idempotency key; first attempt keeps the job key', async () => {
    expect(providerRequestId({ idempotencyKey: 'k', attempt: 0 })).toBe('k');
    expect(providerRequestId({ idempotencyKey: 'k', attempt: 1 })).toBe('k');
    expect(providerRequestId({ idempotencyKey: 'k', attempt: 2 })).toBe('k.a2');

    const s = setup({ maxUploadBytes: 20 * 1024 * 1024, encoder, failFirstSubmit: true });
    const cover = await s.stage('cover.png', 100);
    const clientRequestId = newId();
    const view = await s.orchestrator.createJob(
      { clientRequestId, sourceToken: cover.token, templateId: 'product-review', templateVersion: 'v1', sku: 'RT-1', categoryId: 't-shirt' },
      'emp'
    );
    await waitForJob(s.db, view.job.id, ['FAILED_PROVIDER']);
    await s.orchestrator.retry(view.job.id, true);
    await waitForJob(s.db, view.job.id, ['RUNNING']);

    expect(s.calls.map((c) => c.input.requestId)).toEqual([clientRequestId, `${clientRequestId}.a2`]);
    s.orchestrator.stop();
    s.db.close();
  });
});
