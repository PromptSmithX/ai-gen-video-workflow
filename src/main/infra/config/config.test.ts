import { describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import { assertLoopbackUrl, assertPlatformOrigin, assertDataDir, isAdmin, loadConfig } from './index';

describe('Config Infrastructure', () => {
  const dummyPaths = {
    userData: 'C:\\Users\\testuser\\AppData\\Roaming\\pod-video-studio',
    documents: 'C:\\Users\\testuser\\Documents',
  };

  describe('assertLoopbackUrl', () => {
    it('accepts valid loopback URLs', () => {
      expect(() => assertLoopbackUrl('http://127.0.0.1:47821')).not.toThrow();
      expect(() => assertLoopbackUrl('http://localhost:1')).not.toThrow();
      expect(() => assertLoopbackUrl('http://[::1]:2')).not.toThrow();
      expect(() => assertLoopbackUrl('https://127.0.0.1:8443')).not.toThrow();
      expect(() => assertLoopbackUrl('http://localhost:3000')).not.toThrow();
    });

    it('rejects 0.0.0.0 and LAN IPs', () => {
      expect(() => assertLoopbackUrl('http://0.0.0.0:1')).toThrow(PodError);
      expect(() => assertLoopbackUrl('http://192.168.1.2:1')).toThrow(PodError);
      expect(() => assertLoopbackUrl('http://10.0.0.5:47821')).toThrow(PodError);
    });

    it('rejects public hosts and non-http/https schemes', () => {
      expect(() => assertLoopbackUrl('http://example.com')).toThrow(PodError);
      expect(() => assertLoopbackUrl('ftp://127.0.0.1')).toThrow(PodError);
      expect(() => assertLoopbackUrl('ws://127.0.0.1:47821')).toThrow(PodError);
    });

    it('rejects userinfo, query strings, and fragments', () => {
      expect(() => assertLoopbackUrl('http://user:p@127.0.0.1')).toThrow(PodError);
      expect(() => assertLoopbackUrl('http://127.0.0.1:47821?token=secret')).toThrow(PodError);
      expect(() => assertLoopbackUrl('http://127.0.0.1:47821#hash')).toThrow(PodError);
    });

    it('ensures error message never contains the bad value', () => {
      const badValues = [
        'http://secretuser:secretpass@127.0.0.1',
        'http://192.168.1.99:9999',
        'ftp://127.0.0.1',
        'http://0.0.0.0:1234',
        'http://evil.corp.internal',
      ];

      for (const val of badValues) {
        try {
          assertLoopbackUrl(val);
          expect.fail(`Should have thrown for: ${val}`);
        } catch (err) {
          expect(err).toBeInstanceOf(PodError);
          const podErr = err as PodError;
          expect(podErr.safeMessage).not.toContain(val);
          expect(podErr.message).not.toContain(val);
          expect(podErr.code).toBe('CONFIG_INVALID');
        }
      }
    });
  });

  describe('assertPlatformOrigin', () => {
    it('accepts valid https origin', () => {
      expect(assertPlatformOrigin('https://muse.ai')).toBe('https://muse.ai');
      expect(assertPlatformOrigin('https://app.muse.ai/')).toBe('https://app.muse.ai');
    });

    it('rejects non-https, paths, queries, or userinfo', () => {
      expect(() => assertPlatformOrigin('http://muse.ai')).toThrow(PodError);
      expect(() => assertPlatformOrigin('https://muse.ai/some/path')).toThrow(PodError);
      expect(() => assertPlatformOrigin('https://muse.ai?ref=123')).toThrow(PodError);
      expect(() => assertPlatformOrigin('https://user:p@muse.ai')).toThrow(PodError);
    });
  });

  describe('assertDataDir', () => {
    it('accepts local paths', () => {
      expect(() => assertDataDir('C:\\Users\\user\\AppData')).not.toThrow();
      expect(() => assertDataDir('/home/user/.config')).not.toThrow();
    });

    it('rejects UNC paths without leaking the path in the message', () => {
      const uncPath = '\\\\server\\share\\pod';
      try {
        assertDataDir(uncPath);
        expect.fail('Should have rejected UNC path');
      } catch (err) {
        expect(err).toBeInstanceOf(PodError);
        const podErr = err as PodError;
        expect(podErr.code).toBe('CONFIG_INVALID');
        expect(podErr.message).not.toContain(uncPath);
      }
    });
  });

  describe('loadConfig', () => {
    it('loads defaults correctly', () => {
      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.providerMode).toBe('mock');
      expect(config.bridgeBaseUrl).toBeNull();
      expect(config.musePlatformOrigin).toBeNull();
      expect(config.promptMaxChars).toBe(4000);
      expect(config.pollIntervalMs).toBe(3000);
      expect(config.pollMaxIntervalMs).toBe(15000);
      expect(config.maxSourceBytes).toBe(15 * 1024 * 1024);
      expect(config.maxVideoBytes).toBe(500 * 1024 * 1024);
      expect(config.logRetentionDays).toBe(30);
      expect(config.adminUsers).toEqual([]);
      expect(config.categories.length).toBeGreaterThan(0);
      expect(config.libraryRoot).toContain('POD_VIDEO_LIBRARY');
    });

    it('settings override env defaults', () => {
      const config = loadConfig({
        env: {
          MUSE_BRIDGE_BASE_URL: 'http://127.0.0.1:47821',
          LOG_RETENTION_DAYS: '14',
          POD_ADMIN_USERS: 'alice, bob',
        },
        settings: {
          bridgeBaseUrl: 'http://localhost:5000',
          logRetentionDays: 60,
          adminUsers: ['carol'],
        },
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.bridgeBaseUrl).toBe('http://localhost:5000');
      expect(config.logRetentionDays).toBe(60);
      expect(config.adminUsers).toEqual(['carol']);
    });

    it('enforces number bounds and key naming without leaking bad values', () => {
      const testCases = [
        { env: { PROMPT_MAX_CHARS: '10' }, badVal: '10', key: 'promptMaxChars' },
        { env: { POLL_INTERVAL_MS: '10' }, badVal: '10', key: 'pollIntervalMs' },
        { env: { LOG_RETENTION_DAYS: '500' }, badVal: '500', key: 'logRetentionDays' },
        { env: { MAX_SOURCE_MB: '1000' }, badVal: '1000', key: 'maxSourceBytes' },
      ];

      for (const tc of testCases) {
        try {
          loadConfig({
            env: tc.env,
            settings: {},
            paths: dummyPaths,
            isDev: false,
          });
          expect.fail(`Should have thrown for ${tc.key}`);
        } catch (err) {
          expect(err).toBeInstanceOf(PodError);
          const podErr = err as PodError;
          expect(podErr.code).toBe('CONFIG_INVALID');
          expect(podErr.message).toContain(tc.key);
          expect(podErr.message).not.toContain(tc.badVal);
        }
      }
    });

    it('rejects when pollIntervalMs exceeds pollMaxIntervalMs', () => {
      expect(() =>
        loadConfig({
          env: {
            POLL_INTERVAL_MS: '20000',
            POLL_MAX_INTERVAL_MS: '5000',
          },
          settings: {},
          paths: dummyPaths,
          isDev: false,
        })
      ).toThrow(PodError);
    });
  });

  describe('isAdmin', () => {
    it('returns true in dev mode with empty admin list', () => {
      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: true,
      });
      expect(isAdmin(config, 'anyone')).toBe(true);
      expect(isAdmin(config, null)).toBe(true);
    });

    it('matches username case-insensitively when admin list is present', () => {
      const config = loadConfig({
        env: {},
        settings: {
          adminUsers: ['AliceAdmin', 'BobManager'],
        },
        paths: dummyPaths,
        isDev: true,
      });

      expect(isAdmin(config, 'aliceadmin')).toBe(true);
      expect(isAdmin(config, 'ALICEADMIN')).toBe(true);
      expect(isAdmin(config, 'bobmanager')).toBe(true);
      expect(isAdmin(config, 'charlie')).toBe(false);
      expect(isAdmin(config, null)).toBe(false);
    });

    it('returns false in prod mode with empty admin list', () => {
      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: false,
      });
      expect(isAdmin(config, 'anyone')).toBe(false);
      expect(isAdmin(config, null)).toBe(false);
    });
  });
});
