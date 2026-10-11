/**
 * Persistent store for FinTS Kundensystem-IDs (device recognition).
 *
 * Banks issue a Kundensystem-ID during synchronization (HKSYN) and associate
 * the trusted-device registration with it. If the ID is lost, the bank treats
 * the client as a new device and demands a fresh decoupled confirmation
 * (e.g. pushTAN "Geraet als vertrauenswuerdig speichern"). The IDs are
 * therefore persisted in a small JSON file that survives server restarts.
 *
 * Key format: `${bankCode}:${userId}`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FinTS:SystemIdStore');

function resolveStorePath(): string {
  const configured = config.fints.systemIdStorePath;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function getStoreKey(bankCode: string, userId: string): string {
  return `${bankCode}:${userId}`;
}

function loadStore(): Record<string, string> {
  const storePath = resolveStorePath();
  try {
    if (!existsSync(storePath)) {
      return {};
    }
    return JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, string>;
  } catch (error) {
    logger.warn('Failed to read Kundensystem-ID store, starting fresh', {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function persistStore(store: Record<string, string>): void {
  const storePath = resolveStorePath();
  try {
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch (error) {
    logger.warn('Failed to persist Kundensystem-ID store', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get the stored Kundensystem-ID for a bank/user combination, if any.
 */
export function getStoredSystemId(bankCode: string, userId: string): string | undefined {
  const key = getStoreKey(bankCode, userId);
  const store = loadStore();
  return store[key];
}

/**
 * Store a Kundensystem-ID received from the bank and persist it to disk.
 */
export function storeSystemId(bankCode: string, userId: string, systemId: string): void {
  const key = getStoreKey(bankCode, userId);
  const store = loadStore();
  if (store[key] === systemId) {
    return;
  }
  store[key] = systemId;
  persistStore(store);
  logger.info(`Stored Kundensystem-ID for ${bankCode}:${userId.substring(0, 4)}***`);
}
