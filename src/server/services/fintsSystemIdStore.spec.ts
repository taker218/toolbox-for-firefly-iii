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

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, { systemId?: string }>;
    expect(persisted['39050000:user1']?.systemId).toBe('sid-123');
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

describe('saved connections', () => {
  it('should save connection settings and report them without the PIN', () => {
    store.storeSystemId('39050000', 'user1', 'sid-123');
    store.saveConnection('39050000', 'user1', { url: 'https://banking.example.com/fints', pin: '1234' });

    const connections = store.getSavedConnections();
    const entry = connections.find((c) => c.bankCode === '39050000' && c.userId === 'user1');
    expect(entry).toBeDefined();
    expect(entry?.url).toBe('https://banking.example.com/fints');
    expect(entry?.hasSavedPin).toBe(true);

    // The saved PIN itself must be retrievable server-side only
    expect(store.getSavedPin('39050000', 'user1')).toBe('1234');

    // The system ID stored earlier must survive the connection update
    expect(store.getStoredSystemId('39050000', 'user1')).toBe('sid-123');
  });

  it('should migrate legacy plain-string system ID entries', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(storePath, JSON.stringify({ '10010010:legacy': 'sid-legacy' }), 'utf-8');

    // Re-import to get a fresh module view of the migrated store
    vi.unstubAllEnvs();
    vi.stubEnv('FINTS_SYSTEM_ID_STORE_PATH', storePath);
    const storeModule = await import('./fintsSystemIdStore.js');

    expect(storeModule.getStoredSystemId('10010010', 'legacy')).toBe('sid-legacy');
    expect(storeModule.getSavedConnections().find((c) => c.userId === 'legacy')?.hasSavedPin).toBe(
      false
    );
  });

  it('should return no PIN when none was saved', () => {
    store.saveConnection('50010517', 'user2', { url: 'https://fints.ing.de/fints/' });

    expect(store.getSavedPin('50010517', 'user2')).toBeUndefined();
    expect(
      store.getSavedConnections().find((c) => c.bankCode === '50010517')?.hasSavedPin
    ).toBe(false);
  });
});
