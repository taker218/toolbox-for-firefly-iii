/**
 * Persistent store for FinTS import configurations (mapping + connection
 * metadata), so the importer starts with the same configuration from any
 * client/device.
 *
 * Key format: `${bankCode}:${userId}`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FinTS:ImportConfigStore');

export interface FinTSImportConfig {
  version?: string;
  bank: {
    bankCode: string;
    url?: string;
    userId: string;
  };
  accountIndex?: number;
  dateRange?: { startDate: string; endDate: string };
  converter: unknown;
}

function resolveStorePath(): string {
  const configured = config.fints.importConfigStorePath;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function getStoreKey(bankCode: string, userId: string): string {
  return `${bankCode}:${userId}`;
}

function loadStore(): Record<string, FinTSImportConfig> {
  const storePath = resolveStorePath();
  try {
    if (!existsSync(storePath)) {
      return {};
    }
    return JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, FinTSImportConfig>;
  } catch (error) {
    logger.warn('Failed to read import config store, starting fresh', {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function persistStore(store: Record<string, FinTSImportConfig>): void {
  const storePath = resolveStorePath();
  try {
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch (error) {
    logger.warn('Failed to persist import config store', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get a saved import configuration. Without bankCode/userId the first
 * stored configuration is returned (single-connection setups).
 */
export function getImportConfig(bankCode?: string, userId?: string): FinTSImportConfig | null {
  const store = loadStore();
  if (bankCode && userId) {
    return store[getStoreKey(bankCode, userId)] || null;
  }
  const first = Object.values(store)[0];
  return first || null;
}

/**
 * Save an import configuration for its bank/user combination.
 */
export function saveImportConfig(config: FinTSImportConfig): void {
  const key = getStoreKey(config.bank.bankCode, config.bank.userId);
  const store = loadStore();
  store[key] = config;
  persistStore(store);
  logger.info(`Saved FinTS import config for ${config.bank.bankCode}`);
}
