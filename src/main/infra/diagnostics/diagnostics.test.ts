import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@shared/config';
import { buildDiagnostics } from './index';

describe('Diagnostics Infrastructure', () => {
  const sampleConfig: AppConfig = {
    providerMode: 'bridge',
    bridgeBaseUrl: 'http://127.0.0.1:47821',
    musePlatformOrigin: 'https://muse.ai',
    promptMasterPath: null,
    libraryRoot: 'C:\\Users\\Employee\\POD_VIDEO_LIBRARY',
    dataDir: 'C:\\Users\\Employee\\AppData\\Roaming\\pod',
    promptMaxChars: 4000,
    pollIntervalMs: 3000,
    pollMaxIntervalMs: 15000,
    maxSourceBytes: 15728640,
    maxSourcePixels: 50000000,
    maxVideoBytes: 524288000,
    logRetentionDays: 30,
    adminUsers: ['alice'],
    categories: [],
    isDev: false,
  };

  it('generates human-readable report with host-only URLs and hasApiKey boolean', () => {
    const report = buildDiagnostics({
      appVersion: '0.1.0',
      config: sampleConfig,
      providerStatus: { state: 'ready', quotaRemaining: 50 },
      recentLogLines: ['[2026-11-23T12:00:00Z] job_queued sku=TS-001'],
      jobCounts: { queued: 1, completed: 5 },
      hasApiKey: true,
    });

    expect(report).toContain('POD VIDEO STUDIO - DIAGNOSTICS REPORT');
    expect(report).toContain('App Version: 0.1.0');
    expect(report).toContain('Bridge Host: http://127.0.0.1:47821');
    expect(report).toContain('Platform Origin Host: muse.ai');
    expect(report).toContain('Has Configured API Key: true');
    expect(report).toContain('queued: 1');
    expect(report).toContain('completed: 5');
    expect(report).toContain('job_queued sku=TS-001');
  });

  it('strictly redacts keys, prompt text, bearer tokens, and absolute paths even if passed in', () => {
    const sensitivePrompt =
      'Create a photorealistic video of this SKU with natural fabric folds and soft shadows';
    const secretApiKey = 'sk-live-secret-key-1234567890abcdef12345678';
    const secretBearer = 'Bearer secret-bearer-token-xyz';
    const absolutePath = 'C:\\Users\\admin\\SecretFolder\\mockup.png';
    const signedUrl = 'https://s3.amazonaws.com/videos/output.mp4?X-Amz-Signature=secretSig12345';

    const report = buildDiagnostics({
      appVersion: '0.1.0',
      config: {
        ...sampleConfig,
        bridgeBaseUrl: 'http://127.0.0.1:47821?token=should_be_stripped',
      },
      providerStatus: {
        lastJobPrompt: sensitivePrompt,
        key: secretApiKey,
      },
      recentLogLines: [
        `Error loading ${absolutePath}`,
        `Sending header ${secretBearer}`,
        `Downloading from ${signedUrl}`,
      ],
      jobCounts: { queued: 2 },
      hasApiKey: true,
    });

    // None of the sensitive values must appear in the output
    expect(report).not.toContain(secretApiKey);
    expect(report).not.toContain('secret-bearer-token-xyz');
    expect(report).not.toContain('C:\\Users\\admin');
    expect(report).not.toContain('secretSig12345');
    expect(report).toContain('Has Configured API Key: true');
    expect(report).toContain('[PATH]');
    expect(report).toContain('[REDACTED]');
  });
});
