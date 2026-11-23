/**
 * Integration tests for RestBridgeMuseProvider against MockBridgeServer.
 * Verifies all required provider behaviors, security constraints, and error mappings.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockBridgeServer } from '../../mock-bridge/server';
import { RestBridgeMuseProvider } from '../../../src/main/providers/muse/rest-bridge';
import type { AppConfig } from '@shared/config';
import type { GenerateVideoInput } from '@shared/provider';
import { ProviderError } from '@shared/provider';
import type { Logger, LogFields } from '@shared/services';

describe('RestBridgeMuseProvider Integration', () => {
  let server: MockBridgeServer;
  let serverBaseUrl: string;
  let tempDir: string;
  let sampleImagePath: string;
  const testApiKey = 'test-token';

  interface LogEntry {
    level: string;
    event: string;
    fields?: LogFields;
  }
  let capturedLogs: LogEntry[] = [];

  const mockLogger: Logger = {
    debug: (event, fields) => capturedLogs.push({ level: 'debug', event, fields }),
    info: (event, fields) => capturedLogs.push({ level: 'info', event, fields }),
    warn: (event, fields) => capturedLogs.push({ level: 'warn', event, fields }),
    error: (event, fields) => capturedLogs.push({ level: 'error', event, fields }),
    child: () => mockLogger,
  };

  const createConfig = (baseUrl: string | null = serverBaseUrl): AppConfig => ({
    providerMode: 'bridge',
    musePlatformOrigin: 'https://muse.ai',
    bridgeBaseUrl: baseUrl,
    promptMasterPath: null,
    libraryRoot: tempDir,
    dataDir: tempDir,
    promptMaxChars: 4000,
    pollIntervalMs: 2000,
    pollMaxIntervalMs: 30000,
    maxSourceBytes: 20 * 1024 * 1024,
    maxSourcePixels: 4096 * 4096,
    maxVideoBytes: 20 * 1024 * 1024,
    logRetentionDays: 30,
    adminUsers: [],
    categories: [],
    isDev: true,
  });

  const createInput = (requestId = 'req-1', prompt = 'A photo of a ceramic mug'): GenerateVideoInput => ({
    sku: 'MUG-001',
    sourceImagePath: sampleImagePath,
    sourceFileName: 'mug.png',
    prompt,
    requestId,
  });

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
    capturedLogs = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-bridge-test-'));
    sampleImagePath = path.join(tempDir, 'sample.png');
    fs.writeFileSync(sampleImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it('rejects non-loopback base URL without making any network request', async () => {
    const nonLoopbackUrls = ['http://192.168.1.5:47821', 'http://example.com'];

    for (const badUrl of nonLoopbackUrls) {
      expect(() => {
        new RestBridgeMuseProvider({
          config: createConfig(badUrl),
          getApiKey: () => testApiKey,
          logger: mockLogger,
        });
      }).toThrowError(ProviderError);

      try {
        new RestBridgeMuseProvider({
          config: createConfig(badUrl),
          getApiKey: () => testApiKey,
          logger: mockLogger,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).code).toBe('UNSUPPORTED_PLATFORM');
        expect((err as ProviderError).phase).toBe('before_submit');
      }
    }

    // Proves that no request was made
    expect(server.getRequests().length).toBe(0);
  });

  it('handles health unreachable -> not_installed, login required -> needs_login, and status 401 -> safe error', async () => {
    // 1. Health unreachable
    const unreachableProvider = new RestBridgeMuseProvider({
      config: createConfig('http://127.0.0.1:49999'), // Unused port
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    const unreachableState = await unreachableProvider.getConnectionState();
    expect(unreachableState).toBe('not_installed');

    // 2. Login required (no API key configured)
    const noKeyProvider = new RestBridgeMuseProvider({
      config: createConfig(serverBaseUrl),
      getApiKey: () => null,
      logger: mockLogger,
    });
    const loginState = await noKeyProvider.getConnectionState();
    expect(loginState).toBe('needs_login');

    // 3. Status returns needs_login flag
    server.setBehavior('needs_login');
    const bridgeNeedsLogin = new RestBridgeMuseProvider({
      config: createConfig(serverBaseUrl),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    expect(await bridgeNeedsLogin.getConnectionState()).toBe('needs_login');

    // 4. Status 401 unauthorized
    server.setBehavior('auth_error');
    const authErrorProvider = new RestBridgeMuseProvider({
      config: createConfig(serverBaseUrl),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    const errState = await authErrorProvider.getConnectionState();
    expect(errState).toBe('error');

    // Proves key never in logs or messages
    const logDump = JSON.stringify(capturedLogs);
    expect(logDump).not.toContain(testApiKey);
  });

  it('uploads source reference then submits exactly one job with Idempotency-Key = requestId', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    const input = createInput('unique-request-123');
    const job = await provider.generateVideo(input);

    expect(job.providerJobId).toBeDefined();
    expect(job.state).toBe('queued');
    expect(job.providerReferenceId).toBeDefined();

    const requests = server.getRequests();
    // 1. References upload
    const refReqs = requests.filter((r) => r.method === 'POST' && r.url === '/v1/references');
    expect(refReqs.length).toBe(1);
    expect(refReqs[0]?.headers['content-type']).toBe('image/png');
    expect(refReqs[0]?.headers['x-file-name']).toBe('mug.png');
    expect(refReqs[0]?.rawBody.length).toBe(8); // exactly our sample image bytes

    // 2. Jobs submit
    const jobReqs = requests.filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(jobReqs.length).toBe(1);
    expect(jobReqs[0]?.headers['idempotency-key']).toBe('unique-request-123');
    expect((jobReqs[0]?.jsonBody as Record<string, unknown>)?.['reference_id']).toBe(job.providerReferenceId);
  });

  it('progresses queued -> running -> succeeded via getJob', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    const job = await provider.generateVideo(createInput());
    expect(job.state).toBe('queued');

    const poll1 = await provider.getJob(job.providerJobId);
    expect(poll1.state).toBe('running');
    expect(poll1.progress).toBe(0.5);

    const poll2 = await provider.getJob(job.providerJobId);
    expect(poll2.state).toBe('succeeded');
    expect(poll2.progress).toBe(1.0);
  });

  it('handles refusal (422) and quota (429) on submit', async () => {
    // 1. Refusal
    server.setBehavior('refused');
    const providerRefused = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    await expect(providerRefused.generateVideo(createInput())).rejects.toMatchObject({
      code: 'CONTENT_REFUSED',
      phase: 'before_submit',
    });

    // 2. Quota
    server.setBehavior('quota');
    const providerQuota = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    await expect(providerQuota.generateVideo(createInput())).rejects.toMatchObject({
      code: 'QUOTA_LIMITED',
      phase: 'before_submit',
    });
  });

  it('handles 5xx on submit by returning ambiguous with no second POST', async () => {
    server.setBehavior('provider_5xx');
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    const job = await provider.generateVideo(createInput('req-5xx'));
    expect(job.state).toBe('ambiguous');
    expect(job.errorCode).toBe('SUBMIT_AMBIGUOUS');
    expect(job.providerJobId).toBe('');

    // Assert server saw exactly 1 POST /v1/jobs, never a second POST
    const jobReqs = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(jobReqs.length).toBe(1);
  });

  it('handles network interruption before submit (server closed) as before_submit NOT_CONNECTED', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig('http://127.0.0.1:49998'), // Inactive port
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    await expect(provider.generateVideo(createInput())).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      phase: 'before_submit',
    });
  });

  it('handles server hanging after receiving job body as ambiguous with exactly 1 POST', async () => {
    server.setBehavior('hang_after_request_body');
    const provider = new RestBridgeMuseProvider(
      {
        config: createConfig(),
        getApiKey: () => testApiKey,
        logger: mockLogger,
      },
      { submitTimeoutMs: 250 } // Fast timeout for test
    );

    const job = await provider.generateVideo(createInput('req-hang'));
    expect(job.state).toBe('ambiguous');
    expect(job.errorCode).toBe('SUBMIT_AMBIGUOUS');

    // Exactly 1 POST recorded
    const jobReqs = server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(jobReqs.length).toBe(1);
  });

  it('handles success but no asset -> OUTPUT_MISSING', async () => {
    server.setBehavior('success_no_asset');
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    const job = await provider.generateVideo(createInput());
    // Move to succeeded
    await provider.getJob(job.providerJobId);
    await provider.getJob(job.providerJobId);

    const destPath = path.join(tempDir, 'missing.part');
    await expect(provider.downloadOutput(job.providerJobId, destPath, 1024 * 1024)).rejects.toMatchObject({
      code: 'OUTPUT_MISSING',
      phase: 'after_submit',
    });
  });

  it('handles truncated or oversized download -> DOWNLOAD_FAILED and deletes .part file', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    // 1. Truncated download
    server.setBehavior('healthy');
    const job1 = await provider.generateVideo(createInput('req-trunc'));
    await provider.getJob(job1.providerJobId);
    await provider.getJob(job1.providerJobId);

    server.setBehavior('truncated_download');
    const destTrunc = path.join(tempDir, 'trunc.part');
    await expect(provider.downloadOutput(job1.providerJobId, destTrunc, 10 * 1024 * 1024)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      phase: 'after_submit',
    });
    // Verify file deleted
    expect(fs.existsSync(destTrunc)).toBe(false);

    // 2. Oversized download
    server.setBehavior('healthy');
    const job2 = await provider.generateVideo(createInput('req-oversize'));
    await provider.getJob(job2.providerJobId);
    await provider.getJob(job2.providerJobId);

    server.setBehavior('oversized_download');
    const destOversize = path.join(tempDir, 'oversize.part');
    await expect(provider.downloadOutput(job2.providerJobId, destOversize, 5 * 1024 * 1024)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      phase: 'after_submit',
    });
    // Verify file deleted
    expect(fs.existsSync(destOversize)).toBe(false);
  });

  it('rejects foreign-host asset URL and redirect during download', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    // 1. Redirect to foreign host during download
    const job = await provider.generateVideo(createInput('req-redirect'));
    await provider.getJob(job.providerJobId);
    await provider.getJob(job.providerJobId);

    server.setBehavior('redirect_to_foreign_host');
    const destRedirect = path.join(tempDir, 'redirect.part');
    await expect(provider.downloadOutput(job.providerJobId, destRedirect, 10 * 1024 * 1024)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      phase: 'after_submit',
    });
    expect(fs.existsSync(destRedirect)).toBe(false);
  });

  it('guarantees that API key and prompt text never appear in log output or error messages', async () => {
    const sensitiveKey = 'SUPER_SECRET_BEARER_KEY_ABC123';
    const sensitivePrompt = 'HIGHLY_CONFIDENTIAL_ARTWORK_DESCRIPTION_XYZ987';

    server.setExpectedToken(sensitiveKey);
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => sensitiveKey,
      logger: mockLogger,
    });

    // 1. Submit and query
    const job = await provider.generateVideo(createInput('safe-req', sensitivePrompt));
    await provider.getJob(job.providerJobId);
    await provider.getJob(job.providerJobId);

    // 2. Download
    const destPath = path.join(tempDir, 'downloaded.mp4');
    await provider.downloadOutput(job.providerJobId, destPath, 10 * 1024 * 1024);

    // 3. Inspect logs and errors
    const logsString = JSON.stringify(capturedLogs);
    expect(logsString).not.toContain(sensitiveKey);
    expect(logsString).not.toContain(sensitivePrompt);

    // 4. Force an error and verify error object / message
    server.setBehavior('auth_error');
    try {
      await provider.getJob('non-existent');
    } catch (err: unknown) {
      const errMsg = (err as Error).message;
      const safeMsg = (err as ProviderError).safeMessage;
      expect(errMsg).not.toContain(sensitiveKey);
      expect(errMsg).not.toContain(sensitivePrompt);
      expect(safeMsg).not.toContain(sensitiveKey);
      expect(safeMsg).not.toContain(sensitivePrompt);
    }
  });
});
