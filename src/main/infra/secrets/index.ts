import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PodError } from '@shared/errors';
import type { SecretName, SecretStore } from '@shared/services';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export interface SecretStoreDeps {
  safeStorage: SafeStorageLike;
  filePath: string;
}

/**
 * Creates a DPAPI-backed secret store injecting Electron's safeStorage.
 * If encryption is unavailable, set throws SECRET_STORE_UNAVAILABLE, get returns null,
 * and no plaintext or base64 of plaintext is ever stored.
 * Writes are performed atomically (<filePath>.tmp -> rename) to prevent file corruption.
 * Corrupt files are handled gracefully as empty.
 */
export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const { safeStorage, filePath } = deps;

  function writeAtomically(data: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
      mode: 0o600,
      encoding: 'utf-8',
    });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore on platforms without chmod support
    }
    renameSync(tmpPath, filePath);
  }

  return {
    isAvailable(): boolean {
      return safeStorage.isEncryptionAvailable();
    },

    get(name: SecretName): string | null {
      if (!safeStorage.isEncryptionAvailable()) {
        return null;
      }
      if (!existsSync(filePath)) {
        return null;
      }
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          return null;
        }
        const ciphertextB64 = data[name];
        if (typeof ciphertextB64 !== 'string') {
          return null;
        }
        const encryptedBuf = Buffer.from(ciphertextB64, 'base64');
        return safeStorage.decryptString(encryptedBuf);
      } catch {
        // Corrupt file or decryption failure -> treat as empty, do not crash
        return null;
      }
    },

    set(name: SecretName, value: string): void {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new PodError('SECRET_STORE_UNAVAILABLE');
      }

      let data: Record<string, string> = {};
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            data = parsed as Record<string, string>;
          }
        } catch {
          data = {};
        }
      }

      const encryptedBuf = safeStorage.encryptString(value);
      data[name] = encryptedBuf.toString('base64');

      writeAtomically(data);
    },

    delete(name: SecretName): void {
      if (!existsSync(filePath)) {
        return;
      }
      let data: Record<string, string> = {};
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          data = parsed as Record<string, string>;
        }
      } catch {
        return;
      }
      delete data[name];
      writeAtomically(data);
    },
  };
}

/**
 * Retrieves the bridge API key:
 * Checks secret store first; falls back to MUSE_BRIDGE_API_KEY environment variable
 * (in any mode) when no secret store value exists, but never persists it.
 */
export function getBridgeApiKey(
  store: SecretStore,
  env: NodeJS.ProcessEnv,
  _isDev?: boolean
): string | null {
  const stored = store.get('bridge_api_key');
  if (stored) {
    return stored;
  }
  const fromEnv = env['MUSE_BRIDGE_API_KEY']?.trim();
  if (fromEnv && fromEnv !== '') {
    return fromEnv;
  }
  return null;
}
