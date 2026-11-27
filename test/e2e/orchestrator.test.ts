import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Job } from '@shared/domain';
import { PodError } from '@shared/errors';
import { ProviderError } from '@shared/provider';
import { PROMPT_TEXT_MAX_CHARS } from '@shared/prompt';
import type { JobState } from '@shared/job-state';
import type { CalendarArtworkCompositor, Logger, LogFields, MediaLibrary, PodDatabase, PromptService } from '@shared/services';
import { createAppContainer } from '../../src/main/app/container';
import { ImageStagingService } from '../../src/main/app/image-staging';
import { JobOrchestrator } from '../../src/main/app/job-orchestrator';
import { createUnavailableCompositor } from '../../src/main/app/unavailable-compositor';
import { newId } from '../../src/main/domain/ids';
import { openDatabase } from '../../src/main/infra/db';
import { hashFile } from '../../src/main/infra/media/hash';
import { createMediaLibrary } from '../../src/main/infra/media';
import { createPromptService } from '../../src/main/prompts';
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
  throw new Error(
    `Timeout waiting for job ${jobId} to reach state(s) [${targets.join(', ')}]. Current state: ${finalJob?.state}`
  );
}

describe('JobOrchestrator E2E', () => {
  let server: MockBridgeServer;
  let serverBaseUrl: string;
  let tempRoot: string;
  const testApiKey = 'test-token-e2e';

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
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-e2e-'));
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
    stageImage: (name?: string) => Promise<string>;
  }

  async function createTestStack(opts?: {
    db?: PodDatabase;
    media?: MediaLibrary;
    prompts?: PromptService;
    compositor?: CalendarArtworkCompositor;
    submitTimeoutMs?: number;
    companyMasterPath?: string;
    promptMaxChars?: number;
    pollIntervalMs?: number;
  }): Promise<TestStack> {
    const db = opts?.db ?? openDatabase(path.join(tempRoot, 'test.db'));
    const libraryRoot = path.join(tempRoot, 'library');
    const media =
      opts?.media ??
      createMediaLibrary({
        root: libraryRoot,
        tempDir: path.join(libraryRoot, '.tmp'),
        maxSourceBytes: 15 * 1024 * 1024,
        maxSourcePixels: 4096 * 4096,
        maxVideoBytes: 50 * 1024 * 1024,
      });

    const prompts =
      opts?.prompts ??
      createPromptService({
        builtinDir: path.resolve('prompts'),
        adminDir: path.join(tempRoot, 'admin-prompts'),
        companyMasterPath: opts?.companyMasterPath ?? null,
      });

    const config: AppConfig = {
      providerMode: 'bridge',
      musePlatformOrigin: 'https://muse.ai',
      bridgeBaseUrl: serverBaseUrl,
      promptMasterPath: null,
      libraryRoot,
      dataDir: tempRoot,
      promptMaxChars: opts?.promptMaxChars ?? 4000,
      pollIntervalMs: opts?.pollIntervalMs ?? 100,
      pollMaxIntervalMs: 250,
      maxSourceBytes: 15 * 1024 * 1024,
      maxSourcePixels: 4096 * 4096,
      maxVideoBytes: 50 * 1024 * 1024,
      logRetentionDays: 30,
      adminUsers: ['admin'],
      categories: [
        { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' },
        { id: 'mug', label: 'Mug', promptGroup: 'drinkware' },
      ],
      isDev: true,
    };

    const provider = new RestBridgeMuseProvider(
      {
        config,
        getApiKey: () => testApiKey,
        logger: testLogger,
      },
      opts?.submitTimeoutMs ? { submitTimeoutMs: opts.submitTimeoutMs } : undefined
    );

    const imageStaging = new ImageStagingService();

    const orchestrator = new JobOrchestrator({
      db,
      media,
      prompts,
      provider,
      config,
      logger: testLogger,
      imageStaging,
      compositor: opts?.compositor ?? createUnavailableCompositor(),
    });

    const stageImage = async (name = 'test.png'): Promise<string> => {
      const imgPath = path.join(tempRoot, name);
      fs.writeFileSync(imgPath, buildPngBuffer(120, 120));
      const info = await media.validateImage(imgPath);
      const staged = imageStaging.stage(imgPath, info);
      return staged.token;
    };

    return {
      db,
      media,
      prompts,
      imageStaging,
      orchestrator,
      provider,
      config,
      stageImage,
    };
  }

  // 1. Happy path: create -> QUEUED -> SUBMITTING -> RUNNING -> DOWNLOADING -> SUCCEEDED
  // The company Prompt Master is not in the public repo: this runs only where prompts/company/ exists locally.
  it.skipIf(!fs.existsSync(path.resolve('prompts/company/tshirt-review-v2.md')))('company T-shirt Prompt Master goes verbatim through Muse4AI chat with the mockup attached -> SUCCEEDED', async () => {
    server.setBehavior('healthy');
    server.clearRequests();
    const masterPath = path.resolve('prompts/company/tshirt-review-v2.md');
    const stack = await createTestStack({ companyMasterPath: masterPath, promptMaxChars: PROMPT_TEXT_MAX_CHARS });
    // Whatever version the local company file carries (the file name stays tshirt-review-v2.md).
    const master = stack.prompts.getTemplate('tshirt-review');
    expect(master.source).toBe('company');
    const token = await stack.stageImage('TS-MASTER.png');

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'tshirt-review',
        templateVersion: master.version,
        sku: 'TS-MASTER',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    const done = await waitForJobState(stack.db, view.job.id, 'SUCCEEDED');
    expect(done.state).toBe('SUCCEEDED');

    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(1);
    const body = posts[0]?.jsonBody as Record<string, unknown>;
    expect(body['kind']).toBe('chat');
    expect(Array.isArray(body['attachments'])).toBe(true);
    const sent = String(body['prompt']);
    // Verbatim: the whole company text first, only the category notes appended after it.
    expect(sent.startsWith(master.body.trim())).toBe(true);
    expect(sent.length).toBeGreaterThan(10000);
    // Must fit in one Muse chat message, or Muse4AI rejects it.
    expect(sent.length).toBeLessThanOrEqual(PROMPT_TEXT_MAX_CHARS);
    expect(sent).toContain('AUTHENTIC UGC T-SHIRT PRODUCT REVIEW');
    expect(sent).not.toContain('PLACEHOLDER');
    stack.orchestrator.stop();
  });

  it('happy path: create -> QUEUED -> SUBMITTING -> RUNNING -> DOWNLOADING -> SUCCEEDED', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-001.png');
    const clientRequestId = newId();

    const observedStates: string[] = [];
    stack.orchestrator.on('job:updated', (view) => {
      observedStates.push(view.job.state);
    });

    const initialView = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-001',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    expect(initialView.job.state).toBe('QUEUED');
    expect(initialView.job.skuSnapshot).toBe('TS-001');

    // Wait until SUCCEEDED
    const completed = await waitForJobState(stack.db, initialView.job.id, 'SUCCEEDED');
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.completedAt).toBeTruthy();

    // Verify progression through states
    expect(observedStates).toContain('SUBMITTING');
    expect(observedStates).toContain('RUNNING');
    expect(observedStates).toContain('DOWNLOADING');
    expect(observedStates).toContain('SUCCEEDED');

    // Verify MP4 file stored at <SKU>/videos/<SKU>-video-001.mp4
    const videoRelPath = 'TS-001/videos/TS-001-video-001.mp4';
    const videoAbsPath = stack.media.resolve(videoRelPath);
    expect(fs.existsSync(videoAbsPath)).toBe(true);
    const videoStat = fs.statSync(videoAbsPath);
    expect(videoStat.size).toBeGreaterThan(0);

    // Verify database asset rows
    const assets = stack.db.assets.listByJob(completed.id);
    const sourceAsset = stack.db.assets.getById(completed.sourceAssetId);
    expect(sourceAsset).toBeTruthy();
    expect(sourceAsset?.role).toBe('source_image');

    const promptAsset = assets.find((a) => a.role === 'prompt_snapshot');
    expect(promptAsset).toBeTruthy();

    const videoAsset = assets.find((a) => a.role === 'generated_video');
    expect(videoAsset).toBeTruthy();
    expect(videoAsset?.path).toBe(videoRelPath);

    // Verify SHA matches
    const videoSha = await hashFile(videoAbsPath);
    expect(videoAsset?.sha256).toBe(videoSha);

    // Verify metadata json file
    const metaRelPath = 'TS-001/metadata/TS-001-video-001.json';
    const metaAbsPath = stack.media.resolve(metaRelPath);
    expect(fs.existsSync(metaAbsPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaAbsPath, 'utf-8'));
    expect(meta.jobId).toBe(completed.id);
    expect(meta.sku).toBe('TS-001');
    expect(meta.videoSha256).toBe(videoSha);
    expect(meta.videoBytes).toBe(videoStat.size);
    // Sanitized: no prompt text, no absolute paths
    expect(meta.prompt).toBeUndefined();
    expect(meta.absPath).toBeUndefined();

    stack.orchestrator.stop();
  });

  // 2. Same clientRequestId twice -> one job, bridge saw one POST /v1/jobs
  it('same clientRequestId twice -> one job, bridge saw one POST /v1/jobs', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-002.png');
    const clientRequestId = newId();

    const view1 = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-002',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    const view2 = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-002',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    expect(view1.job.id).toBe(view2.job.id);
    await waitForJobState(stack.db, view1.job.id, 'SUCCEEDED');

    const jobPosts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(jobPosts.length).toBe(1);

    stack.orchestrator.stop();
  });

  // 3. Network interruption after submit (bridge hangs after body) -> AMBIGUOUS, and after recover() still 1 POST
  it('network interruption after submit (bridge hangs) -> AMBIGUOUS, and after recover()/ticks still exactly one POST', async () => {
    server.setBehavior('hang_after_request_body');
    const stack = await createTestStack({ submitTimeoutMs: 250 });
    const token = await stack.stageImage('TS-003.png');
    const clientRequestId = newId();

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-003',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    const ambiguousJob = await waitForJobState(stack.db, view.job.id, 'AMBIGUOUS');
    expect(ambiguousJob.state).toBe('AMBIGUOUS');
    expect(ambiguousJob.errorCode).toBe('SUBMIT_AMBIGUOUS');

    const postsBefore = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length;
    expect(postsBefore).toBe(1);

    // Call recover() and wait a few ticks
    await stack.orchestrator.recover();
    await new Promise((r) => setTimeout(r, 300));

    const postsAfter = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length;
    expect(postsAfter).toBe(1);

    stack.orchestrator.stop();
  });

  // 4. Crash simulation: job left in SUBMITTING in db -> recover() -> AMBIGUOUS, no submit
  it('crash simulation: job left in SUBMITTING in db -> recover() -> AMBIGUOUS, no submit', async () => {
    const stack = await createTestStack();
    server.clearRequests();

    // Manually insert a job in SUBMITTING in the DB
    const jobId = newId();
    const product = stack.db.products.upsertBySku({ sku: 'TS-004', category: 't-shirt', productName: null });
    const sourceAsset = stack.db.assets.insert({
      productId: product.id,
      jobId: null,
      role: 'source_image',
      path: 'TS-004/source/TS-004-original.png',
      mime: 'image/png',
      bytes: 100,
      width: 100,
      height: 100,
      durationMs: null,
      sha256: 'abc123',
    });

    stack.db.jobs.insert({
      id: jobId,
      productId: product.id,
      skuSnapshot: 'TS-004',
      employeeId: 'employee-1',
      provider: 'muse',
      sourceAssetId: sourceAsset.id,
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'abc123',
      promptOverridden: false,
      durationSeconds: null,
      aspectRatio: null,
      idempotencyKey: newId(),
      regeneratedFromJobId: null,
      state: 'SUBMITTING',
    });

    // Run recovery
    await stack.orchestrator.recover();

    const recovered = stack.db.jobs.getById(jobId);
    expect(recovered?.state).toBe('AMBIGUOUS');
    expect(recovered?.errorCode).toBe('SUBMIT_AMBIGUOUS');

    // No POST to provider was made
    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(0);

    stack.orchestrator.stop();
  });

  // 5. RUNNING job survives restart (new orchestrator instance on same db file) and completes
  it('RUNNING job survives restart (new orchestrator instance on same db file) and completes', async () => {
    server.setBehavior('healthy');
    const stack1 = await createTestStack();
    const token = await stack1.stageImage('TS-005.png');

    const view = await stack1.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-005',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    // Wait until RUNNING
    const running = await waitForJobState(stack1.db, view.job.id, 'RUNNING');
    expect(running.state).toBe('RUNNING');
    expect(running.providerJobId).toBeTruthy();

    // Stop first orchestrator (simulating app shutdown)
    stack1.orchestrator.stop();

    // Start second orchestrator instance on the same DB, media library, and prompts
    const stack2 = await createTestStack({
      db: stack1.db,
      media: stack1.media,
      prompts: stack1.prompts,
    });

    // Run recover()
    await stack2.orchestrator.recover();

    // The job resumes polling and completes
    const completed = await waitForJobState(stack2.db, running.id, 'SUCCEEDED');
    expect(completed.state).toBe('SUCCEEDED');

    stack2.orchestrator.stop();
  });

  // 6. Refused / quota / 5xx / no asset / corrupt mp4 -> expected states + codes; quota does not loop
  it('refused / quota / 5xx / no asset / corrupt mp4 map to expected states and codes', async () => {
    // 6a: Refused
    {
      server.clearRequests();
      server.setBehavior('refused');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-REFUSED.png');

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-REFUSED',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      const job = await waitForJobState(stack.db, view.job.id, 'FAILED_REFUSED');
      expect(job.state).toBe('FAILED_REFUSED');
      expect(job.errorCode).toBe('CONTENT_REFUSED');
      stack.orchestrator.stop();
    }

    // 6b: Quota -> does not loop
    {
      server.clearRequests();
      server.setBehavior('quota');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-QUOTA.png');

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-QUOTA',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      const job = await waitForJobState(stack.db, view.job.id, 'FAILED_QUOTA');
      expect(job.state).toBe('FAILED_QUOTA');
      expect(job.errorCode).toBe('QUOTA_LIMITED');

      const jobView = await stack.orchestrator.getJob(job.id);
      expect(jobView.nextActions).not.toContain('retry');
      expect(jobView.nextActions).toContain('regenerate');

      // Verify it stays in FAILED_QUOTA and does not loop
      await new Promise((r) => setTimeout(r, 300));
      const postCount = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length;
      expect(postCount).toBe(1);
      stack.orchestrator.stop();
    }

    // 6c: 5xx on submit -> AMBIGUOUS
    {
      server.clearRequests();
      server.setBehavior('provider_5xx');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-5XX.png');

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-5XX',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      const job = await waitForJobState(stack.db, view.job.id, 'AMBIGUOUS');
      expect(job.state).toBe('AMBIGUOUS');
      expect(job.errorCode).toBe('SUBMIT_AMBIGUOUS');
      stack.orchestrator.stop();
    }

    // 6d: Success but no asset -> DOWNLOAD_FAILED / OUTPUT_MISSING
    {
      server.clearRequests();
      server.setBehavior('success_no_asset');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-NOASSET.png');

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-NOASSET',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      // Default submit mode is chat: a chat turn that succeeds without a video output is terminal (no download
      // loop) and is never resent.
      const job = await waitForJobState(stack.db, view.job.id, 'FAILED_PROVIDER');
      expect(job.state).toBe('FAILED_PROVIDER');
      expect(job.errorCode).toBe('OUTPUT_MISSING');
      expect(server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length).toBe(1);
      stack.orchestrator.stop();
    }

    // 6e: Corrupt / truncated MP4 download -> DOWNLOAD_FAILED
    {
      server.clearRequests();
      server.setBehavior('truncated_download');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-CORRUPT.png');

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-CORRUPT',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      const job = await waitForJobState(stack.db, view.job.id, 'DOWNLOAD_FAILED');
      expect(job.state).toBe('DOWNLOAD_FAILED');
      expect(job.errorCode).toBe('DOWNLOAD_FAILED');
      stack.orchestrator.stop();
    }
  });

  // 7. Retry of FAILED_RETRYABLE reuses the idempotency key; PROVIDER_ERROR retry allowed once only
  it('retry of FAILED_RETRYABLE reuses the idempotency key; PROVIDER_ERROR retry allowed once only', async () => {
    const stack = await createTestStack();
    // Bookkeeping only: keep the background queue from picking up the re-queued jobs (their source files do not
    // exist) and racing the manual state transitions below.
    stack.orchestrator.stop();

    // 7a: FAILED_RETRYABLE retry
    const reqId1 = newId();
    const jobId1 = newId();
    const product = stack.db.products.upsertBySku({ sku: 'TS-007', category: 't-shirt', productName: null });
    const sourceAsset = stack.db.assets.insert({
      productId: product.id,
      jobId: null,
      role: 'source_image',
      path: 'TS-007/source/TS-007-original.png',
      mime: 'image/png',
      bytes: 100,
      width: 100,
      height: 100,
      durationMs: null,
      sha256: 'abc123',
    });

    stack.db.jobs.insert({
      id: jobId1,
      productId: product.id,
      skuSnapshot: 'TS-007',
      employeeId: 'employee-1',
      provider: 'muse',
      sourceAssetId: sourceAsset.id,
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'abc123',
      promptOverridden: false,
      durationSeconds: null,
      aspectRatio: null,
      idempotencyKey: reqId1,
      regeneratedFromJobId: null,
      state: 'FAILED_RETRYABLE',
    });

    const retried1 = await stack.orchestrator.retry(jobId1, true);
    expect(retried1.job.id).toBe(jobId1);
    expect(retried1.job.idempotencyKey).toBe(reqId1);
    expect(retried1.job.attempt).toBe(1);
    expect(retried1.job.state).toBe('QUEUED');

    // 7b: PROVIDER_ERROR retry allowed once only
    const reqId2 = newId();
    const jobId2 = newId();
    stack.db.jobs.insert({
      id: jobId2,
      productId: product.id,
      skuSnapshot: 'TS-007',
      employeeId: 'employee-1',
      provider: 'muse',
      sourceAssetId: sourceAsset.id,
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'abc123',
      promptOverridden: false,
      durationSeconds: null,
      aspectRatio: null,
      idempotencyKey: reqId2,
      regeneratedFromJobId: null,
      state: 'FAILED_PROVIDER',
    });

    // Initial attempt 0 allows retry
    const jobViewAttempt0 = await stack.orchestrator.getJob(jobId2);
    expect(jobViewAttempt0.nextActions).toContain('retry');

    // Perform the allowed single manual retry
    const retriedProvider = await stack.orchestrator.retry(jobId2, true);
    expect(retriedProvider.job.attempt).toBe(1);

    // Fail attempt 2
    stack.db.jobs.transition(jobId2, 'SUBMITTING');
    stack.db.jobs.transition(jobId2, 'FAILED_PROVIDER', {
      errorCode: 'PROVIDER_ERROR',
      safeErrorMessage: 'Server error again',
      attempt: 2,
    });

    const jobViewAttempt2 = await stack.orchestrator.getJob(jobId2);
    expect(jobViewAttempt2.nextActions).not.toContain('retry');
    expect(jobViewAttempt2.nextActions).toContain('regenerate');

    // Attempting retry again must throw
    await expect(stack.orchestrator.retry(jobId2, true)).rejects.toThrow(PodError);

    stack.orchestrator.stop();
  });

  // 8. Regenerate requires confirmation and creates a new key
  it('regenerate requires confirmation and creates a new key', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-008.png');

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-008',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    const completed = await waitForJobState(stack.db, view.job.id, 'SUCCEEDED');

    // Without confirmed: literal true -> rejected
    await expect(
      stack.orchestrator.regenerate(completed.id, false as unknown as true, newId())
    ).rejects.toThrow(PodError);

    // With confirmed: true -> new job with new key
    const newClientRequestId = newId();
    const regeneratedView = await stack.orchestrator.regenerate(completed.id, true, newClientRequestId);

    expect(regeneratedView.job.id).not.toBe(completed.id);
    expect(regeneratedView.job.idempotencyKey).toBe(newClientRequestId);
    expect(regeneratedView.job.regeneratedFromJobId).toBe(completed.id);
    expect(regeneratedView.job.sourceAssetId).toBe(completed.sourceAssetId);

    // The regenerated job is actually submitted with the same prompt and completes
    const regenDone = await waitForJobState(stack.db, regeneratedView.job.id, 'SUCCEEDED');
    expect(regenDone.safeErrorMessage).toBeNull();
    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(2);
    const prompt1 = (posts[0]?.jsonBody as Record<string, unknown>)['prompt'];
    const prompt2 = (posts[1]?.jsonBody as Record<string, unknown>)['prompt'];
    expect(prompt2).toBe(prompt1);

    stack.orchestrator.stop();
  });

  // 8b. Legacy regenerated job without its own prompt snapshot row -> retry falls back to the original's snapshot
  it('retry of a regenerated job without its own snapshot uses the original snapshot', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-008B.png');
    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-008B',
        categoryId: 't-shirt',
      },
      'employee-1'
    );
    const completed = await waitForJobState(stack.db, view.job.id, 'SUCCEEDED');

    // Same shape as rows created by the old regenerate(): no prompt_snapshot asset of its own
    const legacyId = newId();
    stack.db.jobs.insert({
      id: legacyId,
      productId: completed.productId,
      skuSnapshot: completed.skuSnapshot,
      employeeId: completed.employeeId,
      provider: 'muse',
      sourceAssetId: completed.sourceAssetId,
      promptTemplateId: completed.promptTemplateId,
      promptTemplateVersion: completed.promptTemplateVersion,
      promptSha256: completed.promptSha256,
      promptOverridden: completed.promptOverridden,
      durationSeconds: null,
      aspectRatio: null,
      idempotencyKey: newId(),
      regeneratedFromJobId: completed.id,
      state: 'FAILED_RETRYABLE',
    });
    expect(stack.db.assets.listByJob(legacyId)).toHaveLength(0);

    await stack.orchestrator.retry(legacyId, true);
    const done = await waitForJobState(stack.db, legacyId, 'SUCCEEDED');
    expect(done.safeErrorMessage).toBeNull();

    stack.orchestrator.stop();
  });

  // 9. Prompt with unknown placeholder / too long -> createJob rejected, no job row
  it('prompt with unknown placeholder or too long -> createJob rejected, no job row inserted', async () => {
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-009.png');

    // 9a: Prompt override too long
    const tooLongPrompt = 'A'.repeat(5000);
    await expect(
      stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-009',
          categoryId: 't-shirt',
          promptOverride: tooLongPrompt,
        },
        'employee-1'
      )
    ).rejects.toThrow(PodError);

    expect(stack.db.jobs.list().length).toBe(0);

    // 9b: Prompt override with quality failure / unknown placeholder
    const invalidPrompt = 'Short prompt with {{unknown_variable_foo}}';
    await expect(
      stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-009',
          categoryId: 't-shirt',
          promptOverride: invalidPrompt,
        },
        'employee-1'
      )
    ).rejects.toThrow(PodError);

    expect(stack.db.jobs.list().length).toBe(0);

    stack.orchestrator.stop();
  });

  // 10. Polling resilience: bridge down during RUNNING -> stays RUNNING with safe note, bridge back -> SUCCEEDED, exactly 1 POST /v1/jobs
  it('bridge down during RUNNING -> stays RUNNING with safe note, bridge back -> SUCCEEDED, exactly 1 POST /v1/jobs', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack({ pollIntervalMs: 50 });
    const token = await stack.stageImage('TS-POLL-RESILIENT.png');
    const clientRequestId = newId();

    const initialView = await stack.orchestrator.createJob(
      {
        clientRequestId,
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-POLL-RESILIENT',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    // Wait until RUNNING
    const running = await waitForJobState(stack.db, initialView.job.id, 'RUNNING');
    expect(running.state).toBe('RUNNING');

    // Simulate bridge failure during polling (e.g. 500 error / bridge restart)
    server.setCustomGetJobResponse({
      statusCode: 500,
      body: { error: 'INTERNAL_ERROR' },
    });

    // Wait for a poll attempt to encounter the error
    await new Promise((r) => setTimeout(r, 150));

    // Job must still be RUNNING, and safe note must be recorded
    const stillRunning = stack.db.jobs.getById(initialView.job.id);
    expect(stillRunning?.state).toBe('RUNNING');
    expect(stillRunning?.safeErrorMessage).toBe('Connection to the Muse bridge lost — still checking');

    // Bridge comes back
    server.setCustomGetJobResponse(null);

    // Job completes to SUCCEEDED
    const completed = await waitForJobState(stack.db, initialView.job.id, 'SUCCEEDED');
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.safeErrorMessage).toBeNull();

    // Exactly 1 POST /v1/jobs was made
    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(1);

    stack.orchestrator.stop();
  });

  it('provider 404 for an accepted job while polling -> AMBIGUOUS (no retry spin, no resubmit)', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack({ pollIntervalMs: 50 });
    const token = await stack.stageImage('TS-POLL-404.png');
    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-POLL-404',
        categoryId: 't-shirt',
      },
      'employee-1'
    );
    await waitForJobState(stack.db, view.job.id, 'RUNNING');
    server.setCustomGetJobResponse({ statusCode: 404, body: { error: 'NOT_FOUND' } });

    const ambiguous = await waitForJobState(stack.db, view.job.id, 'AMBIGUOUS');
    expect(ambiguous.state).toBe('AMBIGUOUS');

    const getsBefore = server.getRequests().filter((r) => r.method === 'GET' && r.url.startsWith('/v1/jobs/')).length;
    await new Promise((r) => setTimeout(r, 300));
    const getsAfter = server.getRequests().filter((r) => r.method === 'GET' && r.url.startsWith('/v1/jobs/')).length;
    expect(getsAfter).toBe(getsBefore);

    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(1);
    server.setCustomGetJobResponse(null);
    stack.orchestrator.stop();
  });

  it('Muse4AI needs_review while polling -> AMBIGUOUS (no spin); check_again re-reads the job and completes, 1 POST', async () => {
    server.setBehavior('needs_review');
    const stack = await createTestStack({ pollIntervalMs: 50 });
    const token = await stack.stageImage('TS-REVIEW.png');
    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-REVIEW',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    const ambiguous = await waitForJobState(stack.db, view.job.id, 'AMBIGUOUS');
    expect(ambiguous.errorCode).toBe('SUBMIT_AMBIGUOUS');
    expect(ambiguous.providerJobId).toBeTruthy();

    const getsBefore = server.getRequests().filter((r) => r.method === 'GET' && r.url.startsWith('/v1/jobs/')).length;
    await new Promise((r) => setTimeout(r, 300));
    const getsAfter = server.getRequests().filter((r) => r.method === 'GET' && r.url.startsWith('/v1/jobs/')).length;
    expect(getsAfter).toBe(getsBefore);

    // A person resolves it in Muse4AI ("Import from Muse history") -> bridge now reports succeeded.
    server.setCustomGetJobResponse({
      statusCode: 200,
      body: {
        id: ambiguous.providerJobId,
        status: 'succeeded',
        outputs: [{ asset_id: `asset-${ambiguous.providerJobId}`, kind: 'video', mime: 'video/mp4', available: true }],
      },
    });
    const reconciled = await stack.orchestrator.resolveAmbiguous(view.job.id, 'check_again');
    expect(reconciled.job.state).toBe('RUNNING');

    const done = await waitForJobState(stack.db, view.job.id, 'SUCCEEDED');
    expect(done.state).toBe('SUCCEEDED');
    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(1);
    server.setCustomGetJobResponse(null);
    stack.orchestrator.stop();
  });

  // 11. writeMetadata failure continues to SUCCEEDED; storeVideo failure moves to DOWNLOAD_FAILED with exactly 1 downloadOutput
  it('writeMetadata failure continues to SUCCEEDED; storeVideo failure moves to DOWNLOAD_FAILED with exactly 1 downloadOutput', async () => {
    // 11a: writeMetadata failure -> job SUCCEEDED, 1 video stored
    {
      server.clearRequests();
      server.setBehavior('healthy');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-META-FAIL.png');

      // Make writeMetadata throw
      stack.media.writeMetadata = async () => {
        throw new Error('EACCES: permission denied, open metadata');
      };

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-META-FAIL',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      const completed = await waitForJobState(stack.db, view.job.id, 'SUCCEEDED');
      expect(completed.state).toBe('SUCCEEDED');

      // Check stored video exists
      const videoRelPath = 'TS-META-FAIL/videos/TS-META-FAIL-video-001.mp4';
      expect(fs.existsSync(stack.media.resolve(videoRelPath))).toBe(true);

      stack.orchestrator.stop();
    }

    // 11b: storeVideo throws non-PodError -> DOWNLOAD_FAILED, provider.downloadOutput called once (no hot loop)
    {
      server.clearRequests();
      server.setBehavior('healthy');
      const stack = await createTestStack();
      const token = await stack.stageImage('TS-STORE-FAIL.png');

      let downloadOutputCalls = 0;
      const originalDownload = stack.provider.downloadOutput.bind(stack.provider);
      stack.provider.downloadOutput = async (jobId: string, destPath: string, maxBytes: number) => {
        downloadOutputCalls++;
        return originalDownload(jobId, destPath, maxBytes);
      };

      // Make storeVideo throw unexpected non-PodError
      stack.media.storeVideo = async () => {
        throw new Error('Disk write error in storeVideo');
      };

      const view = await stack.orchestrator.createJob(
        {
          clientRequestId: newId(),
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-STORE-FAIL',
          categoryId: 't-shirt',
        },
        'employee-1'
      );

      const failedJob = await waitForJobState(stack.db, view.job.id, 'DOWNLOAD_FAILED');
      expect(failedJob.state).toBe('DOWNLOAD_FAILED');

      // Wait a moment to ensure no hot loop spins
      await new Promise((r) => setTimeout(r, 200));
      expect(downloadOutputCalls).toBe(1);

      stack.orchestrator.stop();
    }
  });

  // 12. Pre-submit validation: missing asset / corrupt snapshot / empty prompt -> QUEUED to FAILED_RETRYABLE without network call
  it('pre-submit validation: missing asset, unreadable/mismatch prompt snapshot -> QUEUED to FAILED_RETRYABLE with 0 network calls', async () => {
    server.clearRequests();
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-PRECHECK.png');

    // Stop orchestrator before creating the job so it doesn't process immediately
    stack.orchestrator.stop();

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-PRECHECK',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    // Corrupt prompt snapshot on disk so hash mismatches
    const assets = stack.db.assets.listByJob(view.job.id);
    const promptAsset = assets.find((a) => a.role === 'prompt_snapshot')!;
    const promptAbsPath = stack.media.resolve(promptAsset.path);
    fs.writeFileSync(promptAbsPath, 'tampered prompt text that does not match sha256');

    // Start a new orchestrator to process the QUEUED job via recover()
    const stack2 = await createTestStack({
      db: stack.db,
      media: stack.media,
      prompts: stack.prompts,
    });
    await stack2.orchestrator.recover();

    const failed = await waitForJobState(stack2.db, view.job.id, 'FAILED_RETRYABLE');
    expect(failed.state).toBe('FAILED_RETRYABLE');
    expect(failed.errorCode).toBe('INVALID_PROMPT');

    // 0 POST /v1/jobs calls
    const posts = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(posts.length).toBe(0);

    stack2.orchestrator.stop();
  });

  // 13. cancel(): if provider.cancelJob throws, throw PROVIDER_ERROR and leave state RUNNING
  it('cancel(): if provider.cancelJob throws, throw PROVIDER_ERROR and leave state RUNNING', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-CANCEL.png');

    const view = await stack.orchestrator.createJob(
      {
        clientRequestId: newId(),
        sourceToken: token,
        templateId: 'product-review',
        templateVersion: 'v2',
        sku: 'TS-CANCEL',
        categoryId: 't-shirt',
      },
      'employee-1'
    );

    const running = await waitForJobState(stack.db, view.job.id, 'RUNNING');
    expect(running.state).toBe('RUNNING');

    // Make provider.cancelJob throw
    stack.provider.cancelJob = async () => {
      throw new ProviderError('PROVIDER_ERROR', 'after_submit', 'Network connection severed during cancel');
    };

    // Attempt cancel -> rejects with PodError('PROVIDER_ERROR')
    await expect(stack.orchestrator.cancel(running.id)).rejects.toThrow(PodError);

    // Job in DB must remain RUNNING
    const current = stack.db.jobs.getById(running.id);
    expect(current?.state).toBe('RUNNING');

    // Check logged warning has code only, not String(err)
    const cancelLogs = capturedLogs.filter((l) => l.event === 'job_cancel_provider_failed');
    expect(cancelLogs.length).toBe(1);
    expect(cancelLogs[0]?.fields?.code).toBe('PROVIDER_ERROR');
    expect(cancelLogs[0]?.fields?.error).toBeUndefined();

    stack.orchestrator.stop();
  });

  // 14. createJob idempotency race: Promise.all of two concurrent creates -> 1 job row, 1 source file
  it('createJob idempotency race: Promise.all of two concurrent creates -> 1 job row, 1 source file', async () => {
    server.setBehavior('healthy');
    const stack = await createTestStack();
    const token = await stack.stageImage('TS-RACE.png');
    const clientRequestId = newId();

    const [view1, view2] = await Promise.all([
      stack.orchestrator.createJob(
        {
          clientRequestId,
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-RACE',
          categoryId: 't-shirt',
        },
        'employee-1'
      ),
      stack.orchestrator.createJob(
        {
          clientRequestId,
          sourceToken: token,
          templateId: 'product-review',
          templateVersion: 'v2',
          sku: 'TS-RACE',
          categoryId: 't-shirt',
        },
        'employee-1'
      ),
    ]);

    expect(view1.job.id).toBe(view2.job.id);
    expect(stack.db.jobs.list().length).toBe(1);

    // Check source files in SKU folder: exactly 1 source image
    const sourceDir = path.join(stack.config.libraryRoot, 'TS-RACE', 'source');
    if (fs.existsSync(sourceDir)) {
      const sourceFiles = fs.readdirSync(sourceDir);
      expect(sourceFiles.length).toBe(1);
    }

    stack.orchestrator.stop();
  });

  // 15. createAppContainer throws PodError('CONFIG_INVALID') on invalid config (no Electron needed)
  it('createAppContainer throws PodError("CONFIG_INVALID") on bad bridgeBaseUrl', () => {
    expect(() => {
      createAppContainer({
        appPath: tempRoot,
        userData: path.join(tempRoot, 'userdata'),
        documents: path.join(tempRoot, 'docs'),
        isPackaged: false,
        env: {
          MUSE_BRIDGE_BASE_URL: 'http://192.168.1.100:8080',
        },
      });
    }).toThrow(PodError);

    try {
      createAppContainer({
        appPath: tempRoot,
        userData: path.join(tempRoot, 'userdata'),
        documents: path.join(tempRoot, 'docs'),
        isPackaged: false,
        env: {
          MUSE_BRIDGE_BASE_URL: 'http://192.168.1.100:8080',
        },
      });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PodError);
      if (err instanceof PodError) {
        expect(err.code).toBe('CONFIG_INVALID');
        expect(err.safeMessage).toContain('bridgeBaseUrl');
      }
    }
  });
});
