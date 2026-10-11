import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { getStoredSystemId, storeSystemId } from './fintsSystemIdStore.js';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

let store: {
  getStoredSystemId: typeof getStoredSystemId;
  storeSystemId: typeof storeSystemId;
};
let storePath: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fints-system-id-store-'));
  storePath = join(dir, 'system-ids.json');
  vi.stubEnv('FINTS_SYSTEM_ID_STORE_PATH', storePath);
  store = await import('./fintsSystemIdStore.js');
});

describe('fintsSystemIdStore', () => {
  it('returns undefined when nothing was stored yet', () => {
    expect(store.getStoredSystemId('39050000', 'user1')).toBeUndefined();
  });

  it('stores a system ID and persists it to disk', () => {
    store.storeSystemId('39050000', 'user1', 'sid-123');

    expect(store.getStoredSystemId('39050000', 'user1')).toBe('sid-123');

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, string>;
    expect(persisted['39050000:user1']).toBe('sid-123');
  });

  it('keeps entries for other bank/user combinations separate', () => {
    store.storeSystemId('50010517', 'user2', 'sid-456');

    expect(store.getStoredSystemId('39050000', 'user1')).toBe('sid-123');
    expect(store.getStoredSystemId('50010517', 'user2')).toBe('sid-456');
    expect(store.getStoredSystemId('39050000', 'other')).toBeUndefined();
  });

  it('overwrites an existing system ID for the same bank/user combination', () => {
    store.storeSystemId('39050000', 'user1', 'sid-789');

    expect(store.getStoredSystemId('39050000', 'user1')).toBe('sid-789');
  });
});
