import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupLogs, createLogger, redactFields, redactText } from './index';

describe('Logging Infrastructure & Redaction', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pod-logging-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('redactText', () => {
    it('redacts Bearer tokens in headers or text', () => {
      const input = 'Authorization header: Bearer abcdef1234567890xyz and Bearer my-secret-token';
      const output = redactText(input);
      expect(output).toBe('Authorization header: Bearer [REDACTED] and Bearer [REDACTED]');
    });

    it('redacts sk-... long tokens and hex tokens', () => {
      const input = 'Tokens: sk-live-1234567890abcdef12345678 and 0123456789abcdef0123456789abcdef';
      const output = redactText(input);
      expect(output).not.toContain('sk-live-1234567890abcdef12345678');
      expect(output).not.toContain('0123456789abcdef0123456789abcdef');
      expect(output).toContain('[REDACTED]');
    });

    it('redacts URL query strings (e.g. signed URLs, secret params)', () => {
      const input = 'Fetching from https://bridge.local/v1/jobs/123?sig=secret12345&expires=99999';
      const output = redactText(input);
      expect(output).toBe('Fetching from https://bridge.local/v1/jobs/123?[REDACTED]');
    });

    it('redacts absolute Windows paths and UNC paths', () => {
      const input =
        'Saved to C:\\Users\\Administrator\\Documents\\secret.mp4 and \\\\server\\share\\video.mp4';
      const output = redactText(input);
      expect(output).toBe('Saved to [PATH] and [PATH]');
    });

    it('redacts cookie strings', () => {
      const input = 'Header Cookie: session_id=secret_abc123; tracking=xyz';
      const output = redactText(input);
      expect(output).toContain('cookie=[REDACTED]');
      expect(output).not.toContain('secret_abc123');
    });
  });

  describe('redactFields', () => {
    it('drops/replaces sensitive keys matching policy', () => {
      const fields = {
        prompt: 'Create a video with natural folds on a red t-shirt',
        apiKey: 'secret-api-key-1234',
        authorization: 'Bearer 987654321',
        cookie: 'user_session=456',
        sessionToken: 'xyz789',
        signature: 'sig_abcdef',
        signedUrl: 'https://example.com/file?token=123',
        normalField: 'safeValue',
        filePath: 'C:\\Users\\test\\file.png',
      };

      const redacted = redactFields(fields);

      expect(redacted['prompt']).toBe('[REDACTED]');
      expect(redacted['apiKey']).toBe('[REDACTED]');
      expect(redacted['authorization']).toBe('[REDACTED]');
      expect(redacted['cookie']).toBe('[REDACTED]');
      expect(redacted['sessionToken']).toBe('[REDACTED]');
      expect(redacted['signature']).toBe('[REDACTED]');
      expect(redacted['signedUrl']).toBe('[REDACTED]');
      expect(redacted['normalField']).toBe('safeValue');
      expect(redacted['filePath']).toBe('[PATH]');
    });
  });

  describe('createLogger file writing and redaction', () => {
    it('writes redacted JSON lines to log file', async () => {
      const logger = createLogger({
        dir: tempDir,
        retentionDays: 30,
        level: 'debug',
      });

      logger.info('job_started', {
        sku: 'TS-001',
        prompt: 'A person wearing this hoodie',
        apiKey: 'secret-key-to-redact',
        path: 'C:\\Users\\Employee\\mockup.png',
        url: 'https://bridge.local/api?token=secret123',
        header: 'Bearer 1234567890abcdef',
        cookie: 'sid=secret-session',
      });

      await logger.flush();

      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(tempDir, `pod-${today}.log`);
      expect(existsSync(logFile)).toBe(true);

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());

      expect(parsed.event).toBe('job_started');
      expect(parsed.sku).toBe('TS-001');
      expect(parsed.prompt).toBe('[REDACTED]');
      expect(parsed.apiKey).toBe('[REDACTED]');
      expect(parsed.path).toBe('[PATH]');
      expect(parsed.url).toBe('https://bridge.local/api?[REDACTED]');
      expect(parsed.header).toBe('Bearer [REDACTED]');
      expect(parsed.cookie).toBe('[REDACTED]');
      expect(content).not.toContain('A person wearing this hoodie');
      expect(content).not.toContain('secret-key-to-redact');
      expect(content).not.toContain('C:\\Users\\Employee');
      expect(content).not.toContain('secret123');
      expect(content).not.toContain('secret-session');
    });

    it('respects child logger inheritance and log levels', async () => {
      const logger = createLogger({
        dir: tempDir,
        retentionDays: 30,
        level: 'warn',
      });

      const child = logger.child({ component: 'media-library' });

      child.info('ignored_event', { detail: 'should not be logged' });
      child.warn('warning_event', { detail: 'something warned' });

      await logger.flush();

      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(tempDir, `pod-${today}.log`);

      const content = readFileSync(logFile, 'utf-8');
      expect(content).not.toContain('ignored_event');
      expect(content).toContain('warning_event');
      expect(content).toContain('media-library');
    });
  });

  describe('cleanupLogs', () => {
    it('deletes files older than retentionDays and keeps recent ones', () => {
      const now = new Date();
      const format = (d: Date) => d.toISOString().slice(0, 10);

      // 40 days ago (should be deleted for retentionDays=30)
      const oldDate = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
      const oldFile = path.join(tempDir, `pod-${format(oldDate)}.log`);
      writeFileSync(oldFile, 'old log content');

      // 5 days ago (should be kept)
      const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      const recentFile = path.join(tempDir, `pod-${format(recentDate)}.log`);
      writeFileSync(recentFile, 'recent log content');

      // Non-log file (should be untouched)
      const otherFile = path.join(tempDir, 'notes.txt');
      writeFileSync(otherFile, 'notes');

      const deleted = cleanupLogs(tempDir, 30);

      expect(deleted).toBe(1);
      expect(existsSync(oldFile)).toBe(false);
      expect(existsSync(recentFile)).toBe(true);
      expect(existsSync(otherFile)).toBe(true);
    });
  });
});
