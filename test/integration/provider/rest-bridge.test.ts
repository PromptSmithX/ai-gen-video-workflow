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

  const createConfig = (
    baseUrl: string | null = serverBaseUrl,
    museSubmitMode: 'chat' | 'video' = 'chat'
  ): AppConfig => ({
    providerMode: 'bridge',
    museSubmitMode,
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

    // 2. No API key configured returns error (UI shows hasApiKey separately)
    const noKeyProvider = new RestBridgeMuseProvider({
      config: createConfig(serverBaseUrl),
      getApiKey: () => null,
      logger: mockLogger,
    });
    const loginState = await noKeyProvider.getConnectionState();
    expect(loginState).toBe('error');

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
      config: createConfig(serverBaseUrl, 'video'),
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
    // Muse4AI reports no progress percentage; never fabricated.
    expect(poll1.progress).toBeUndefined();

    const poll2 = await provider.getJob(job.providerJobId);
    expect(poll2.state).toBe('succeeded');
    expect(poll2.providerAssetId).toBe(`asset-${job.providerJobId}`);
  });

  it('sends only Muse4AI CreateJob fields (no duration/aspect) and a percent-encoded X-File-Name', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(serverBaseUrl, 'video'),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    const input = { ...createInput('req-fields'), sourceFileName: 'áo thun.png', durationSeconds: 10, aspectRatio: '9:16' as const };
    const job = await provider.generateVideo(input);
    expect(job.state).toBe('queued');

    const ref = server.getRequests().find((r) => r.url === '/v1/references');
    expect(ref?.headers['x-file-name']).toBe(encodeURIComponent('áo thun.png'));
    const post = server.getRequests().find((r) => r.method === 'POST' && r.url === '/v1/jobs');
    expect(Object.keys(post?.jsonBody as Record<string, unknown>).sort()).toEqual(
      ['account', 'kind', 'mode', 'prompt', 'reference_id', 'repeat'].sort()
    );
  });

  it('maps Muse4AI needs_review to ambiguous and failed error codes to safe codes', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    server.setCustomGetJobResponse({ statusCode: 200, body: { id: 'job-x', status: 'needs_review', state: 'needs_review' } });
    const review = await provider.getJob('job-x');
    expect(review.state).toBe('ambiguous');
    expect(review.errorCode).toBe('SUBMIT_AMBIGUOUS');

    const cases: Array<[string, string]> = [
      ['QUOTA_LIMIT', 'QUOTA_LIMITED'],
      ['CONTENT_REFUSED', 'CONTENT_REFUSED'],
      ['SESSION_EXPIRED', 'NEEDS_LOGIN'],
      ['PROVIDER_ERROR', 'PROVIDER_ERROR'],
      ['UI_CHANGED', 'PROVIDER_ERROR'],
    ];
    for (const [bridgeCode, expected] of cases) {
      server.setCustomGetJobResponse({
        statusCode: 200,
        body: { id: 'job-x', status: 'failed', error: { code: bridgeCode, message: 'x' }, outputs: [] },
      });
      const failed = await provider.getJob('job-x');
      expect(failed.state).toBe('failed');
      expect(failed.errorCode).toBe(expected);
    }

    // Unknown public status -> ambiguous (stop and ask a human), never guessed as success/failure
    server.setCustomGetJobResponse({ statusCode: 200, body: { id: 'job-x', status: 'something_new' } });
    expect((await provider.getJob('job-x')).state).toBe('ambiguous');
    server.setCustomGetJobResponse(null);
  });

  it('derives connection state and capabilities from Muse4AI /v1/status (chat: 32000 chars, 2 MiB image)', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    expect(await provider.getConnectionState()).toBe('ready');
    const caps = await provider.getCapabilities();
    expect(caps).toMatchObject({
      canCancel: true,
      reportsProgress: false,
      supportedDurations: [],
      supportedAspectRatios: [],
      maxPromptChars: 32000,
      // Chat attachments go inline on the HTTP path: Muse4AI refuses images over 2 MiB (422 capability_unavailable)
      maxUploadBytes: 2 * 1024 * 1024,
    });

    const videoProvider = new RestBridgeMuseProvider({
      config: createConfig(serverBaseUrl, 'video'),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    expect(await videoProvider.getCapabilities()).toMatchObject({
      maxPromptChars: 4000,
      maxUploadBytes: 20 * 1024 * 1024,
    });
  });

  it('chat mode sends the full long prompt verbatim with the mockup attached, and downloads the video', async () => {
    server.clearRequests();
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    const longPrompt = 'Preserve the exact artwork. '.repeat(400); // ~11 200 chars, > 4000 video limit
    const job = await provider.generateVideo(createInput('req-chat-long', longPrompt));
    expect(job.state).toBe('queued');

    const post = server.getRequests().find((r) => r.method === 'POST' && r.url === '/v1/jobs');
    const body = post?.jsonBody as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['account', 'attachments', 'kind', 'prompt']);
    expect(body['kind']).toBe('chat');
    expect(body['prompt']).toBe(longPrompt);
    expect(body['attachments']).toEqual([job.providerReferenceId]);
    expect(post?.headers['idempotency-key']).toBe('req-chat-long');

    await provider.getJob(job.providerJobId); // running
    const done = await provider.getJob(job.providerJobId);
    expect(done.state).toBe('succeeded');
    const destPath = path.join(tempDir, 'chat-video.mp4');
    const result = await provider.downloadOutput(job.providerJobId, destPath, 10 * 1024 * 1024);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('chat mode: Muse answers with text only -> failed OUTPUT_MISSING (terminal, nothing resent)', async () => {
    server.setBehavior('chat_no_video');
    server.clearRequests();
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });
    const job = await provider.generateVideo(createInput('req-chat-text'));
    await provider.getJob(job.providerJobId); // running
    const done = await provider.getJob(job.providerJobId);
    expect(done.state).toBe('failed');
    expect(done.errorCode).toBe('OUTPUT_MISSING');
    expect(done.providerAssetId).toBeUndefined();
    expect(server.getRequests().filter((r) => r.method === 'POST' && r.url === '/v1/jobs').length).toBe(1);
    server.setBehavior('healthy');
  });

  it('maps submitJob 4xx responses per explicit review table', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    // Row 1: 401, 403 (no body code) -> NEEDS_LOGIN, phase before_submit
    server.setCustomJobResponse({ statusCode: 401, body: {} });
    await expect(provider.generateVideo(createInput('req-401'))).rejects.toMatchObject({
      code: 'NEEDS_LOGIN',
      phase: 'before_submit',
    });

    server.setCustomJobResponse({ statusCode: 403, body: {} });
    await expect(provider.generateVideo(createInput('req-403'))).rejects.toMatchObject({
      code: 'NEEDS_LOGIN',
      phase: 'before_submit',
    });

    // Row 2: 400, 413, 415, 422 -> PROVIDER_ERROR (validation), phase before_submit
    for (const status of [400, 413, 415, 422]) {
      server.setCustomJobResponse({ statusCode: status, body: { message: 'Invalid payload' } });
      await expect(provider.generateVideo(createInput(`req-${status}`))).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        phase: 'before_submit',
      });
    }

    // Row 3: 429 (rate limited / queue full; Muse4AI creates nothing) -> QUOTA_LIMITED, before_submit
    server.setCustomJobResponse({ statusCode: 429, body: { status: 429, code: 'rate_limited' } });
    await expect(provider.generateVideo(createInput('req-429-before'))).rejects.toMatchObject({
      code: 'QUOTA_LIMITED',
      phase: 'before_submit',
    });

    // Muse4AI problem+json: invalid_api_key -> NEEDS_LOGIN
    server.setCustomJobResponse({ statusCode: 401, body: { status: 401, code: 'invalid_api_key' } });
    await expect(provider.generateVideo(createInput('req-badkey'))).rejects.toMatchObject({
      code: 'NEEDS_LOGIN',
      phase: 'before_submit',
    });

    // Row 4: Explicit refusal code -> CONTENT_REFUSED, phase after_submit
    server.setCustomJobResponse({ statusCode: 422, body: { code: 'content_refused' } });
    await expect(provider.generateVideo(createInput('req-refused-1'))).rejects.toMatchObject({
      code: 'CONTENT_REFUSED',
      phase: 'after_submit',
    });

    server.setCustomJobResponse({ statusCode: 400, body: { code: 'refused' } });
    await expect(provider.generateVideo(createInput('req-refused-2'))).rejects.toMatchObject({
      code: 'CONTENT_REFUSED',
      phase: 'after_submit',
    });

    server.setCustomJobResponse({ statusCode: 400, body: { code: 'safety' } });
    await expect(provider.generateVideo(createInput('req-refused-3'))).rejects.toMatchObject({
      code: 'CONTENT_REFUSED',
      phase: 'after_submit',
    });

    // Explicit body error codes for quota and login
    server.setCustomJobResponse({ statusCode: 400, body: { code: 'quota' } });
    await expect(provider.generateVideo(createInput('req-code-quota'))).rejects.toMatchObject({
      code: 'QUOTA_LIMITED',
      phase: 'before_submit',
    });


    server.setCustomJobResponse({ statusCode: 400, body: { code: 'login_required' } });
    await expect(provider.generateVideo(createInput('req-code-login'))).rejects.toMatchObject({
      code: 'NEEDS_LOGIN',
      phase: 'before_submit',
    });

    // Row 5: 408, 409 and any other 4xx -> return ambiguous (SUBMIT_AMBIGUOUS), never resubmit
    for (const otherStatus of [408, 409, 418]) {
      server.setCustomJobResponse({ statusCode: otherStatus, body: { message: 'Conflict or timeout' } });
      const job = await provider.generateVideo(createInput(`req-amb-${otherStatus}`));
      expect(job.state).toBe('ambiguous');
      expect(job.errorCode).toBe('SUBMIT_AMBIGUOUS');
    }
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

  it('wraps getJob and cancelJob connection errors and JSON parse failures', async () => {
    // 1. Stopped bridge connection refused for getJob
    const stoppedBridgeProvider = new RestBridgeMuseProvider({
      config: createConfig('http://127.0.0.1:49997'), // inactive port
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    await expect(stoppedBridgeProvider.getJob('job-123')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      phase: 'after_submit',
    });

    // When bridge is stopped/unreachable, cancel is unsupported so cancelJob safely throws INVALID_STATE
    await expect(stoppedBridgeProvider.cancelJob('job-123')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      phase: 'before_submit',
    });

    // 2. Unparseable JSON returned by bridge for getJob
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    server.setCustomGetJobResponse({
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'MALFORMED_NON_JSON_RESPONSE',
    });

    await expect(provider.getJob('job-123')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      phase: 'after_submit',
    });

    // 3. cancelJob fetch timeout when canCancel capability is supported
    const cancelTimeoutProvider = new RestBridgeMuseProvider(
      {
        config: createConfig(),
        getApiKey: () => testApiKey,
        logger: mockLogger,
      },
      { standardTimeoutMs: 100 }
    );
    // Populate capability cache while server is healthy
    await cancelTimeoutProvider.getCapabilities();

    server.setBehavior('hang_after_request_body');
    await expect(cancelTimeoutProvider.cancelJob('job-123')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      phase: 'after_submit',
    });
    server.reset();
  });

  it('wraps pre-download getJob failure as DOWNLOAD_FAILED in downloadOutput', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    // Force getJob to fail with 500
    server.setCustomGetJobResponse({
      statusCode: 500,
      body: { error: 'INTERNAL_ERROR' },
    });

    const destPath = path.join(tempDir, 'fail-download.part');
    await expect(provider.downloadOutput('job-123', destPath, 1024 * 1024)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      phase: 'after_submit',
    });
  });

  it('rejects image files without a valid PNG, JPEG, or WEBP signature', async () => {
    const provider = new RestBridgeMuseProvider({
      config: createConfig(),
      getApiKey: () => testApiKey,
      logger: mockLogger,
    });

    // Write a file with .png extension but invalid magic bytes
    const fakeImagePath = path.join(tempDir, 'fake.png');
    fs.writeFileSync(fakeImagePath, Buffer.from('NOT_A_VALID_IMAGE_SIGNATURE'));

    const invalidInput: GenerateVideoInput = {
      sku: 'TS-999',
      sourceImagePath: fakeImagePath,
      sourceFileName: 'fake.png',
      prompt: 'Valid prompt text',
      requestId: 'req-invalid-img',
    };

    await expect(provider.generateVideo(invalidInput)).rejects.toMatchObject({
      code: 'INVALID_IMAGE',
      phase: 'before_submit',
    });
  });
});
