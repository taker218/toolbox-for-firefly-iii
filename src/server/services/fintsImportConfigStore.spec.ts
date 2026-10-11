import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { getImportConfig, saveImportConfig } from './fintsImportConfigStore.js';

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
  getImportConfig: typeof getImportConfig;
  saveImportConfig: typeof saveImportConfig;
};
let storePath: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fints-import-config-store-'));
  storePath = join(dir, 'import-configs.json');
  vi.stubEnv('FINTS_IMPORT_CONFIG_STORE_PATH', storePath);
  store = await import('./fintsImportConfigStore.js');
});

const sampleConfig = {
  version: '1.0',
  bank: {
    bankCode: '39050000',
    url: 'https://banking-rl3.s-fints-pt-rl.de/fints30',
    userId: 'user1',
  },
  accountIndex: 1,
  dateRange: { startDate: '2026-10-01', endDate: '2026-10-11' },
  converter: { swimlanes: [] },
};

describe('fintsImportConfigStore', () => {
  it('returns null when nothing was saved yet', () => {
    expect(store.getImportConfig('39050000', 'user1')).toBeNull();
  });

  it('saves a config and returns it per bank/user and as the first entry', () => {
    store.saveImportConfig(sampleConfig);

    expect(store.getImportConfig('39050000', 'user1')).toEqual(sampleConfig);
    expect(store.getImportConfig()).toEqual(sampleConfig);

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted['39050000:user1']).toEqual(sampleConfig);
  });

  it('keeps configurations of different bank/user combinations separate', () => {
    store.saveImportConfig({
      ...sampleConfig,
      bank: { bankCode: '50010517', userId: 'user2' },
    });

    expect(store.getImportConfig('39050000', 'user1')).toEqual(sampleConfig);
    expect(store.getImportConfig('50010517', 'user2')?.bank.bankCode).toBe('50010517');
  });
});
