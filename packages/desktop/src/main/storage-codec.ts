import { safeStorage } from 'electron';
import type { StorageCodec } from './storage.js';

export interface StorageCodecLogger {
  warn(message: string, detail?: unknown): void;
}

const SENSITIVE_COLLECTIONS = new Set(['auth']);

/**
 * Uses Keychain / DPAPI / the desktop secret service for credentials while
 * keeping large, non-secret archives as efficient UTF-8 JSON in SQLite.
 */
export class ElectronStorageCodec implements StorageCodec {
  private warnedUnavailable = false;

  constructor(private readonly logger: StorageCodecLogger) {}

  encode(collection: string, json: string): ReturnType<StorageCodec['encode']> {
    if (!SENSITIVE_COLLECTIONS.has(collection)) {
      return { payload: Buffer.from(json, 'utf8'), encoding: 'json' };
    }
    const insecureLinuxBackend =
      process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
    if (safeStorage.isEncryptionAvailable() && !insecureLinuxBackend) {
      return { payload: safeStorage.encryptString(json), encoding: 'safe-storage-v1' };
    }
    // Electron's Linux `basic_text` backend uses a hardcoded password and is
    // explicitly not secure. Keep the signed-in session usable for this run,
    // but never write the credential to disk without a real OS secret store.
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      this.logger.warn('OS credential encryption is unavailable; auth data is session-only and will not be persisted');
    }
    return {
      payload: Buffer.from(json, 'utf8'),
      encoding: 'volatile-json-v1',
      persistent: false,
    };
  }

  decode(collection: string, payload: Uint8Array, encoding: string): string {
    if (encoding === 'json') return Buffer.from(payload).toString('utf8');
    if (encoding === 'volatile-json-v1' && SENSITIVE_COLLECTIONS.has(collection)) {
      return Buffer.from(payload).toString('utf8');
    }
    if (encoding === 'safe-storage-v1' && SENSITIVE_COLLECTIONS.has(collection)) {
      return safeStorage.decryptString(Buffer.from(payload));
    }
    throw new Error(`Unsupported storage encoding: ${encoding}`);
  }
}
