import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import { createSecretStore, getBridgeApiKey, type SafeStorageLike } from './index';

describe('Secrets Infrastructure', () => {
  let tempDir: string;
  let secretFilePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pod-secrets-test-'));
    secretFilePath = path.join(tempDir, 'secrets.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  function makeMockSafeStorage(available: boolean): SafeStorageLike {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (s: string) => {
        // Prepend an encryption marker to simulate encrypted buffer
        return Buffer.from(`ENC:${s}`, 'utf-8');
      },
      decryptString: (b: Buffer) => {
        const str = b.toString('utf-8');
        if (!str.startsWith('ENC:')) {
          throw new Error('Decryption failure: invalid header');
        }
        return str.slice(4);
      },
    };
  }

  describe('When encryption is unavailable', () => {
    it('set throws SECRET_STORE_UNAVAILABLE and creates no file', () => {
      const mockSafeStorage = makeMockSafeStorage(false);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });

      expect(store.isAvailable()).toBe(false);
      expect(() => store.set('bridge_api_key', 'my-super-secret-api-key')).toThrow(PodError);

      try {
        store.set('bridge_api_key', 'my-super-secret-api-key');
      } catch (err) {
        expect(err).toBeInstanceOf(PodError);
        expect((err as PodError).code).toBe('SECRET_STORE_UNAVAILABLE');
      }

      expect(existsSync(secretFilePath)).toBe(false);
    });

    it('get returns null and does not throw', () => {
      const mockSafeStorage = makeMockSafeStorage(false);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });

      expect(store.get('bridge_api_key')).toBeNull();
    });
  });

  describe('When encryption is available', () => {
    it('round trips values without storing plaintext', () => {
      const mockSafeStorage = makeMockSafeStorage(true);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });

      const secretValue = 'top-secret-token-12345';
      store.set('bridge_api_key', secretValue);

      // Verify file exists
      expect(existsSync(secretFilePath)).toBe(true);

      // Check file content does NOT contain raw plaintext or raw base64 of plaintext
      const rawFileContent = readFileSync(secretFilePath, 'utf-8');
      expect(rawFileContent).not.toContain(secretValue);
      expect(rawFileContent).not.toContain(Buffer.from(secretValue).toString('base64'));

      // Verify round-trip retrieval
      const retrieved = store.get('bridge_api_key');
      expect(retrieved).toBe(secretValue);
    });

    it('tolerates corrupt file without crashing', () => {
      const mockSafeStorage = makeMockSafeStorage(true);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });

      // Write corrupt JSON to file
      writeFileSync(secretFilePath, '{"bridge_api_key": "not-valid-base64-or-corrupt-data}');

      expect(store.get('bridge_api_key')).toBeNull();

      // Setting a new value recovers cleanly
      store.set('bridge_api_key', 'recovered-key');
      expect(store.get('bridge_api_key')).toBe('recovered-key');
    });

    it('deletes secret successfully', () => {
      const mockSafeStorage = makeMockSafeStorage(true);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });

      store.set('bridge_api_key', 'token-to-delete');
      expect(store.get('bridge_api_key')).toBe('token-to-delete');

      store.delete('bridge_api_key');
      expect(store.get('bridge_api_key')).toBeNull();
    });
  });

  describe('getBridgeApiKey helper', () => {
    it('returns stored key first even if env is set in dev', () => {
      const mockSafeStorage = makeMockSafeStorage(true);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });
      store.set('bridge_api_key', 'from-store');

      const key = getBridgeApiKey(store, { MUSE_BRIDGE_API_KEY: 'from-env' }, true);
      expect(key).toBe('from-store');
    });

    it('falls back to env MUSE_BRIDGE_API_KEY ONLY in dev mode', () => {
      const mockSafeStorage = makeMockSafeStorage(true);
      const store = createSecretStore({
        safeStorage: mockSafeStorage,
        filePath: secretFilePath,
      });

      // In dev: falls back to env
      const devKey = getBridgeApiKey(store, { MUSE_BRIDGE_API_KEY: 'from-env' }, true);
      expect(devKey).toBe('from-env');

      // In production (isDev = false): env is ignored
      const prodKey = getBridgeApiKey(store, { MUSE_BRIDGE_API_KEY: 'from-env' }, false);
      expect(prodKey).toBeNull();
    });
  });
});
