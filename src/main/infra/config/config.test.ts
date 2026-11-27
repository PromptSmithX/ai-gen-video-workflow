import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import { createSecretStore, getBridgeApiKey, type SafeStorageLike } from '../secrets/index';
import {
  assertLoopbackUrl,
  assertPlatformOrigin,
  assertDataDir,
  isAdmin,
  loadConfig,
  readEffectiveEnv,
} from './index';

describe('Config Infrastructure', () => {
  let tempDir: string;
  let dummyPaths: { userData: string; documents: string };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pod-config-test-'));
    dummyPaths = {
      userData: path.join(tempDir, 'userData'),
      documents: path.join(tempDir, 'documents'),
    };
    mkdirSync(dummyPaths.userData, { recursive: true });
    mkdirSync(dummyPaths.documents, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

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

  describe('bridgeBaseUrl normalization', () => {
    it('strips trailing slashes from bridgeBaseUrl', () => {
      const config1 = loadConfig({
        env: { MUSE_BRIDGE_BASE_URL: 'http://127.0.0.1:47821/' },
        settings: {},
        paths: dummyPaths,
        isDev: false,
      });
      expect(config1.bridgeBaseUrl).toBe('http://127.0.0.1:47821');

      const config2 = loadConfig({
        env: {},
        settings: { bridgeBaseUrl: 'http://localhost:3000///' },
        paths: dummyPaths,
        isDev: false,
      });
      expect(config2.bridgeBaseUrl).toBe('http://localhost:3000');
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
    it('MUSE_SUBMIT_MODE: chat (default) | video, anything else rejected', () => {
      const load = (v: string | undefined) =>
        loadConfig({ env: v === undefined ? {} : { MUSE_SUBMIT_MODE: v }, settings: {}, paths: dummyPaths, isDev: false });
      expect(load(undefined).museSubmitMode).toBe('chat');
      expect(load('video').museSubmitMode).toBe('video');
      expect(load('CHAT').museSubmitMode).toBe('chat');
      expect(() => load('browser')).toThrow(PodError);
    });

    it('bundled Muse4AI: installed app defaults to the real bridge; env overrides; dev keeps .env behaviour', () => {
      const bundle = { muse4aiExePath: 'C:/app/resources/muse4ai/Muse4AI.exe', promptMasterPath: 'C:/app/resources/prompts/company/m.md' };
      const installed = loadConfig({ env: {}, settings: {}, paths: dummyPaths, isDev: false, bundle });
      expect(installed.providerMode).toBe('bridge');
      expect(installed.bridgeBaseUrl).toBe('http://127.0.0.1:47821');
      expect(installed.musePlatformOrigin).toBe('https://muse.ai');
      expect(installed.promptMasterPath).toBe(bundle.promptMasterPath);
      expect(installed.muse4aiExePath).toBe(bundle.muse4aiExePath);
      expect(installed.muse4aiProxyPort).toBe(8080);

      const overridden = loadConfig({ env: { PROVIDER_MODE: 'mock', MUSE4AI_PROXY_PORT: '18080' }, settings: {}, paths: dummyPaths, isDev: false, bundle });
      expect(overridden.providerMode).toBe('mock');
      expect(overridden.muse4aiProxyPort).toBe(18080);

      const emptyEnv = path.join(mkdtempSync(path.join(os.tmpdir(), 'pod-cfg-')), '.env');
      writeFileSync(emptyEnv, '');
      const dev = loadConfig({ env: {}, settings: {}, paths: dummyPaths, isDev: true, envFilePath: emptyEnv, bundle: { muse4aiExePath: bundle.muse4aiExePath, promptMasterPath: null } });
      expect(dev.providerMode).toBe('mock');
      expect(() => loadConfig({ env: { MUSE4AI_PROXY_PORT: '80' }, settings: {}, paths: dummyPaths, isDev: false })).toThrow(PodError);
    });

    it('loads defaults correctly', () => {
      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.providerMode).toBe('mock');
      expect(config.museSubmitMode).toBe('chat');
      expect(config.bridgeBaseUrl).toBeNull();
      expect(config.musePlatformOrigin).toBeNull();
      expect(config.promptMaxChars).toBe(32000);
      expect(config.pollIntervalMs).toBe(3000);
      expect(config.pollMaxIntervalMs).toBe(15000);
      expect(config.maxSourceBytes).toBe(15 * 1024 * 1024);
      expect(config.maxVideoBytes).toBe(500 * 1024 * 1024);
      expect(config.logRetentionDays).toBe(30);
      expect(config.adminUsers).toEqual([]);
      expect(config.categories.length).toBeGreaterThan(0);
      expect(config.libraryRoot).toContain('POD_VIDEO_LIBRARY');
    });

    it('treats empty env values (e.g. from copied .env.example) as unset and falls back to defaults', () => {
      const blankEnvContent = `
PROVIDER_MODE=
MUSE_PLATFORM_ORIGIN=
MUSE_BRIDGE_BASE_URL=
MUSE_BRIDGE_API_KEY=
PROMPT_MASTER_PATH=
POD_LIBRARY_ROOT=
PROMPT_MAX_CHARS=
POLL_INTERVAL_MS=
POLL_MAX_INTERVAL_MS=
MAX_SOURCE_MB=
MAX_SOURCE_PIXELS=
MAX_VIDEO_MB=
LOG_RETENTION_DAYS=
POD_ADMIN_USERS=
CSC_LINK=
CSC_KEY_PASSWORD=
`;
      const envFilePath = path.join(tempDir, 'blank.env');
      writeFileSync(envFilePath, blankEnvContent);

      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: false,
        envFilePath,
      });

      expect(config.providerMode).toBe('mock');
      expect(config.bridgeBaseUrl).toBeNull();
      expect(config.musePlatformOrigin).toBeNull();
      expect(config.promptMasterPath).toBeNull();
      expect(config.promptMaxChars).toBe(32000);
      expect(config.pollIntervalMs).toBe(3000);
      expect(config.pollMaxIntervalMs).toBe(15000);
      expect(config.maxSourceBytes).toBe(15 * 1024 * 1024);
      expect(config.maxSourcePixels).toBe(50000000);
      expect(config.maxVideoBytes).toBe(500 * 1024 * 1024);
      expect(config.logRetentionDays).toBe(30);
      expect(config.adminUsers).toEqual([]);
    });

    it('supports optional .env in paths.userData when not in dev mode', () => {
      const prodEnvPath = path.join(dummyPaths.userData, '.env');
      const prodEnvContent = `
PROVIDER_MODE=bridge
MUSE_BRIDGE_BASE_URL=http://127.0.0.1:47821
LOG_RETENTION_DAYS=14
`;
      writeFileSync(prodEnvPath, prodEnvContent);

      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.providerMode).toBe('bridge');
      expect(config.bridgeBaseUrl).toBe('http://127.0.0.1:47821');
      expect(config.logRetentionDays).toBe(14);
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

  describe('readEffectiveEnv and getBridgeApiKey integration', () => {
    function makeMockSafeStorage(available: boolean): SafeStorageLike {
      return {
        isEncryptionAvailable: () => available,
        encryptString: (s: string) => Buffer.from(`ENC:${s}`, 'utf-8'),
        decryptString: (b: Buffer) => b.toString('utf-8').slice(4),
      };
    }

    it('reads MUSE_BRIDGE_API_KEY from .env into effectiveEnv and supplies getBridgeApiKey, while store value still wins', () => {
      const envPath = path.join(tempDir, 'key-test.env');
      writeFileSync(envPath, 'MUSE_BRIDGE_API_KEY=abc\n');

      const effectiveEnv = readEffectiveEnv({
        env: {},
        isDev: true,
        userDataDir: dummyPaths.userData,
        envFilePath: envPath,
      });

      expect(effectiveEnv['MUSE_BRIDGE_API_KEY']).toBe('abc');

      const mockSafeStorage = makeMockSafeStorage(true);
      const secretFile = path.join(tempDir, 'secrets.json');
      const storeWithoutKey = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFile,
      });

      // When store has no key, effectiveEnv provides the fallback
      expect(getBridgeApiKey(storeWithoutKey, effectiveEnv)).toBe('abc');

      // When store has a key, the store value wins
      storeWithoutKey.set('bridge_api_key', 'store-key-wins');
      expect(getBridgeApiKey(storeWithoutKey, effectiveEnv)).toBe('store-key-wins');
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

  describe('categories normalization and merge', () => {
    it('fresh config has desk-calendar category by default', () => {
      const config = loadConfig({
        env: {},
        settings: {},
        paths: dummyPaths,
        isDev: false,
      });

      const deskCal = config.categories.find((c) => c.id === 'desk-calendar');
      expect(deskCal).toBeDefined();
      expect(deskCal?.promptGroup).toBe('calendar');
    });

    it('legacy stored list without desk-calendar gets it appended at the end while custom categories remain untouched', () => {
      const legacyList = [
        { id: 't-shirt', label: 'Custom T-Shirt', promptGroup: 'apparel' as const },
        { id: 'custom-hoodie', label: 'My Hoodie', promptGroup: 'apparel' as const },
        { id: 'custom-mug', label: 'Coffee Mug', promptGroup: 'drinkware' as const },
      ];

      const config = loadConfig({
        env: {},
        settings: { categories: legacyList },
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.categories).toHaveLength(4);
      expect(config.categories[0]).toEqual(legacyList[0]);
      expect(config.categories[1]).toEqual(legacyList[1]);
      expect(config.categories[2]).toEqual(legacyList[2]);
      expect(config.categories[3]).toEqual({
        id: 'desk-calendar',
        label: 'Desk Calendar',
        promptGroup: 'calendar',
      });
    });

    it('stored list already containing desk-calendar (even with edited label) is untouched', () => {
      const storedWithDeskCal = [
        { id: 'desk-calendar', label: 'Renamed Desk Calendar', promptGroup: 'calendar' as const },
        { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' as const },
      ];

      const config = loadConfig({
        env: {},
        settings: { categories: storedWithDeskCal },
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.categories).toHaveLength(2);
      expect(config.categories).toEqual(storedWithDeskCal);
      expect(config.categories[0]?.label).toBe('Renamed Desk Calendar');
    });

    it('stored list with another calendar-group category does not get a second one', () => {
      const customCalendar = [
        { id: 'wall-calendar', label: 'Wall Calendar', promptGroup: 'calendar' as const },
        { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' as const },
      ];

      const config = loadConfig({
        env: {},
        settings: { categories: customCalendar },
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.categories).toHaveLength(2);
      expect(config.categories).toEqual(customCalendar);
      expect(config.categories.some((c) => c.id === 'desk-calendar')).toBe(false);
    });

    it('invalid promptGroup is still rejected', () => {
      const invalidList = [
        { id: 'custom', label: 'Custom', promptGroup: 'books' as unknown as 'apparel' },
      ];

      expect(() =>
        loadConfig({
          env: {},
          settings: { categories: invalidList },
          paths: dummyPaths,
          isDev: false,
        })
      ).toThrow(PodError);

      try {
        loadConfig({
          env: {},
          settings: { categories: invalidList },
          paths: dummyPaths,
          isDev: false,
        });
      } catch (err) {
        expect((err as PodError).code).toBe('CONFIG_INVALID');
        expect((err as PodError).message).toContain('categories');
      }
    });

    it('valid calendar promptGroup is accepted', () => {
      const validCalendar = [
        { id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' as const },
      ];

      const config = loadConfig({
        env: {},
        settings: { categories: validCalendar },
        paths: dummyPaths,
        isDev: false,
      });

      expect(config.categories).toEqual(validCalendar);
    });
  });
});
