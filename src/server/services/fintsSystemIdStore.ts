/**
 * Persistent store for FinTS Kundensystem-IDs (device recognition) and
 * saved connection settings.
 *
 * Banks issue a Kundensystem-ID during synchronization (HKSYN) and associate
 * the trusted-device registration with it. If the ID is lost, the bank treats
 * the client as a new device and demands a fresh decoupled confirmation
 * (e.g. pushTAN "Geraet als vertrauenswuerdig speichern"). The IDs are
 * therefore persisted in a small JSON file that survives server restarts.
 *
 * Stored entries may optionally contain the bank endpoint URL and - only if
 * the user explicitly opted in via the importer UI - the banking PIN, so the
 * importer can prefill and auto-connect on the next visit. The PIN is stored
 * in plain text in this file: it is only as safe as the host the toolbox
 * runs on. Keep the file protected and never commit it.
 *
 * Key format: `${bankCode}:${userId}`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FinTS:SystemIdStore');

/**
 * A stored connection entry. Older versions of this store kept plain
 * system-ID strings; those are migrated to { systemId } on load.
 */
export interface StoredConnection {
  systemId?: string;
  url?: string;
  pin?: string;
}

function resolveStorePath(): string {
  const configured = config.fints.systemIdStorePath;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function getStoreKey(bankCode: string, userId: string): string {
  return `${bankCode}:${userId}`;
}

function parseEntry(value: unknown): StoredConnection {
  if (typeof value === 'string') {
    // Legacy format: entry was just the system-ID string
    return { systemId: value };
  }
  if (value && typeof value === 'object') {
    return value as StoredConnection;
  }
  return {};
}

function loadStore(): Record<string, StoredConnection> {
  const storePath = resolveStorePath();
  try {
    if (!existsSync(storePath)) {
      return {};
    }
    const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, unknown>;
    const store: Record<string, StoredConnection> = {};
    for (const [key, value] of Object.entries(raw)) {
      store[key] = parseEntry(value);
    }
    return store;
  } catch (error) {
    logger.warn('Failed to read Kundensystem-ID store, starting fresh', {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function persistStore(store: Record<string, StoredConnection>): void {
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
  const entry = loadStore()[getStoreKey(bankCode, userId)];
  return entry?.systemId;
}

/**
 * Store a Kundensystem-ID received from the bank and persist it to disk.
 * Other connection data on the same entry (url, pin) is preserved.
 */
export function storeSystemId(bankCode: string, userId: string, systemId: string): void {
  const key = getStoreKey(bankCode, userId);
  const store = loadStore();
  if (store[key]?.systemId === systemId) {
    return;
  }
  store[key] = { ...store[key], systemId };
  persistStore(store);
  logger.info(`Stored Kundensystem-ID for ${bankCode}:${userId.substring(0, 4)}***`);
}

/**
 * Save connection settings (endpoint URL, optionally the PIN if the user
 * opted in). Existing system IDs on the same entry are preserved.
 */
export function saveConnection(
  bankCode: string,
  userId: string,
  connection: { url?: string; pin?: string }
): void {
  const key = getStoreKey(bankCode, userId);
  const store = loadStore();
  const entry = store[key] || {};
  const url = connection.url?.trim();
  const pin = connection.pin?.trim();

  store[key] = {
    ...entry,
    url: url || entry.url,
    pin: pin || (connection.pin === '' ? undefined : entry.pin),
  };
  persistStore(store);
  logger.info(`Saved FinTS connection settings for ${bankCode}:${userId.substring(0, 4)}***`);
}

/**
 * Get the saved PIN for a bank/user combination, if the user opted in.
 */
export function getSavedPin(bankCode: string, userId: string): string | undefined {
  const entry = loadStore()[getStoreKey(bankCode, userId)];
  return entry?.pin;
}

/**
 * List all saved connections for the importer UI. PINs are never returned.
 */
export function getSavedConnections(): Array<{
  bankCode: string;
  userId: string;
  url?: string;
  hasSavedPin: boolean;
}> {
  const store = loadStore();
  return Object.entries(store).map(([key, entry]) => {
    const separator = key.indexOf(':');
    const bankCode = separator === -1 ? key : key.slice(0, separator);
    const userId = separator === -1 ? '' : key.slice(separator + 1);
    return {
      bankCode,
      userId,
      url: entry.url,
      hasSavedPin: Boolean(entry.pin),
    };
  });
}
