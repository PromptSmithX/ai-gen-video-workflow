/**
 * Unit and integration tests for MockMuseProvider and polling helper.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MockMuseProvider,
  nextPollDelay,
  isValidMp4Buffer,
} from '../../../src/main/providers/muse';
import type { GenerateVideoInput } from '@shared/provider';

describe('MockMuseProvider', () => {
  let tempDir: string;
  let sampleImagePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-mock-test-'));
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

  const createInput = (requestId = 'req-1', prompt = 'A rotating t-shirt mockup'): GenerateVideoInput => ({
    sku: 'TS-001',
    sourceImagePath: sampleImagePath,
    sourceFileName: 'sample.png',
    prompt,
    requestId,
  });

  it('is idempotent per requestId and counts generations accurately', async () => {
    const provider = new MockMuseProvider({ scenario: 'success' });
    expect(provider.getGenerationCount()).toBe(0);

    const input = createInput('stable-req-id-1');
    const job1 = await provider.generateVideo(input);
    expect(provider.getGenerationCount()).toBe(1);
    expect(job1.state).toBe('queued');
    expect(job1.providerJobId).toBeDefined();

    // Re-submitting with the exact same requestId returns the same job and does not re-generate
    const job2 = await provider.generateVideo(input);
    expect(provider.getGenerationCount()).toBe(1);
    expect(job2.providerJobId).toBe(job1.providerJobId);

    // Different requestId increments generation count
    const job3 = await provider.generateVideo(createInput('different-req-id'));
    expect(provider.getGenerationCount()).toBe(2);
    expect(job3.providerJobId).not.toBe(job1.providerJobId);
  });

  it('progresses queued -> running -> succeeded via getJob', async () => {
    const provider = new MockMuseProvider({ scenario: 'success' });
    const job = await provider.generateVideo(createInput());
    expect(job.state).toBe('queued');

    const poll1 = await provider.getJob(job.providerJobId);
    expect(poll1.state).toBe('running');

    const poll2 = await provider.getJob(job.providerJobId);
    expect(poll2.state).toBe('succeeded');
  });

  it('supports findJobByRequestId', async () => {
    const provider = new MockMuseProvider({ scenario: 'success' });
    const notFound = await provider.findJobByRequestId('non-existent');
    expect(notFound).toBeNull();

    const job = await provider.generateVideo(createInput('search-id-123'));
    const found = await provider.findJobByRequestId('search-id-123');
    expect(found).not.toBeNull();
    expect(found?.providerJobId).toBe(job.providerJobId);
  });

  it('supports cancelJob', async () => {
    const provider = new MockMuseProvider({ scenario: 'success', canCancel: true });
    const job = await provider.generateVideo(createInput());
    await provider.cancelJob(job.providerJobId);

    const cancelled = await provider.getJob(job.providerJobId);
    expect(cancelled.state).toBe('cancelled');
  });

  it('writes a valid MP4 starting with ftyp box on download', async () => {
    const provider = new MockMuseProvider({ scenario: 'success' });
    const job = await provider.generateVideo(createInput());
    // Move to succeeded
    await provider.getJob(job.providerJobId);
    await provider.getJob(job.providerJobId);

    const destPath = path.join(tempDir, 'output.mp4');
    const result = await provider.downloadOutput(job.providerJobId, destPath, 10 * 1024 * 1024);
    expect(result.bytes).toBeGreaterThan(0);

    const fileContent = fs.readFileSync(destPath);
    expect(isValidMp4Buffer(fileContent)).toBe(true);
    // Byte 4..7 is ftyp
    expect(fileContent.toString('ascii', 4, 8)).toBe('ftyp');
  });

  it('maps each scenario to the expected state or error', async () => {
    // 1. not_connected
    const pNotConnected = new MockMuseProvider({ scenario: 'not_connected' });
    expect(await pNotConnected.getConnectionState()).toBe('not_installed');
    await expect(pNotConnected.generateVideo(createInput())).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      phase: 'before_submit',
    });

    // 2. needs_login
    const pLogin = new MockMuseProvider({ scenario: 'needs_login' });
    expect(await pLogin.getConnectionState()).toBe('needs_login');
    await expect(pLogin.generateVideo(createInput())).rejects.toMatchObject({
      code: 'NEEDS_LOGIN',
      phase: 'before_submit',
    });

    // 3. quota
    const pQuota = new MockMuseProvider({ scenario: 'quota' });
    expect(await pQuota.getConnectionState()).toBe('quota_limited');
    await expect(pQuota.generateVideo(createInput())).rejects.toMatchObject({
      code: 'QUOTA_LIMITED',
      phase: 'before_submit',
    });

    // 4. refused
    const pRefused = new MockMuseProvider({ scenario: 'refused' });
    await expect(pRefused.generateVideo(createInput())).rejects.toMatchObject({
      code: 'CONTENT_REFUSED',
      phase: 'after_submit',
    });

    // 5. provider_5xx
    const p5xx = new MockMuseProvider({ scenario: 'provider_5xx' });
    expect(await p5xx.getConnectionState()).toBe('error');
    const job5xx = await p5xx.generateVideo(createInput());
    expect(job5xx.state).toBe('ambiguous');
    expect(job5xx.errorCode).toBe('SUBMIT_AMBIGUOUS');

    // 6. ambiguous
    const pAmbiguous = new MockMuseProvider({ scenario: 'ambiguous' });
    const jobAmb = await pAmbiguous.generateVideo(createInput());
    expect(jobAmb.state).toBe('ambiguous');
    expect(jobAmb.errorCode).toBe('SUBMIT_AMBIGUOUS');

    // 7. success_no_asset
    const pNoAsset = new MockMuseProvider({ scenario: 'success_no_asset' });
    const jobNoAsset = await pNoAsset.generateVideo(createInput());
    await pNoAsset.getJob(jobNoAsset.providerJobId);
    await pNoAsset.getJob(jobNoAsset.providerJobId);
    await expect(
      pNoAsset.downloadOutput(jobNoAsset.providerJobId, path.join(tempDir, 'fail.mp4'), 1024 * 1024)
    ).rejects.toMatchObject({
      code: 'OUTPUT_MISSING',
      phase: 'after_submit',
    });

    // 8. corrupt_mp4
    const pCorrupt = new MockMuseProvider({ scenario: 'corrupt_mp4' });
    const jobCorrupt = await pCorrupt.generateVideo(createInput());
    await pCorrupt.getJob(jobCorrupt.providerJobId);
    await pCorrupt.getJob(jobCorrupt.providerJobId);
    const corruptDest = path.join(tempDir, 'corrupt.mp4');
    await pCorrupt.downloadOutput(jobCorrupt.providerJobId, corruptDest, 1024 * 1024);
    const corruptBytes = fs.readFileSync(corruptDest);
    expect(isValidMp4Buffer(corruptBytes)).toBe(false);
  });
});

describe('nextPollDelay', () => {
  it('is bounded and increasing', () => {
    const baseMs = 1000;
    const maxMs = 16000;

    let previousDelay = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = nextPollDelay(attempt, baseMs, maxMs);
      expect(delay).toBeLessThanOrEqual(maxMs);
      expect(delay).toBeGreaterThanOrEqual(baseMs);

      if (previousDelay > 0 && previousDelay < maxMs) {
        expect(delay).toBeGreaterThanOrEqual(previousDelay);
      }
      previousDelay = delay;
    }

    // High attempt is capped at maxMs
    const capped = nextPollDelay(25, baseMs, maxMs);
    expect(capped).toBe(maxMs);
  });
});
