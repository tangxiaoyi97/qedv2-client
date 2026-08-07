import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = vi.hoisted(() => ({
  decryptString: vi.fn<(payload: Buffer) => string>(),
  encryptString: vi.fn<(value: string) => Buffer>(),
  getSelectedStorageBackend: vi.fn(() => 'keychain'),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('electron', () => ({ safeStorage }));

import { ElectronStorageCodec } from '../src/main/storage-codec.js';

describe('ElectronStorageCodec Keychain access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.getSelectedStorageBackend.mockReturnValue('keychain');
    safeStorage.encryptString.mockImplementation((value) => Buffer.from(`encrypted:${value}`));
    safeStorage.decryptString.mockImplementation((payload) =>
      payload.toString('utf8').replace(/^encrypted:/u, ''));
  });

  it('does not initialize safeStorage for non-auth data', () => {
    const codec = new ElectronStorageCodec({ warn: vi.fn() });

    expect(codec.encode('config', '{"theme":"dark"}')).toMatchObject({ encoding: 'json' });
    expect(codec.decode('history', Buffer.from('[]'), 'json')).toBe('[]');
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('encrypts a login once and reuses its plaintext for every window restore', () => {
    const codec = new ElectronStorageCodec({ warn: vi.fn() });
    const json = '{"token":"secret"}';
    const encoded = codec.encode('auth', json);
    const duplicate = codec.encode('auth', json);

    expect(codec.decode('auth', encoded.payload, encoded.encoding)).toBe(json);
    expect(codec.decode('auth', Buffer.from(encoded.payload), encoded.encoding)).toBe(json);
    expect(duplicate).toEqual(encoded);
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('decrypts a persisted login at most once per process', () => {
    const codec = new ElectronStorageCodec({ warn: vi.fn() });
    const payload = Buffer.from('encrypted:{"token":"restored"}');

    expect(codec.decode('auth', payload, 'safe-storage-v1')).toContain('restored');
    expect(codec.decode('auth', Buffer.from(payload), 'safe-storage-v1')).toContain('restored');
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
  });
});
