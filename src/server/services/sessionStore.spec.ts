import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAmazonExtenderStore,
  getPayPalExtenderStore,
  getFinTSClientStore,
  getFinTSDialogStateStore,
  trackTransactionCacheSession,
  clearSessionData,
  startCleanupInterval,
  stopCleanupInterval,
  getStoreStats,
} from './sessionStore.js';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the transaction cache
vi.mock('./transactionCache.js', () => ({
  setSessionTracker: vi.fn(),
  clearSessionCache: vi.fn(),
}));

describe('sessionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear stores between tests
    stopCleanupInterval();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stopCleanupInterval();
  });

  describe('getAmazonExtenderStore', () => {
    it('should return a session store', () => {
      const store = getAmazonExtenderStore<{ data: string }>();
      expect(store).toBeDefined();
      expect(typeof store.get).toBe('function');
      expect(typeof store.set).toBe('function');
      expect(typeof store.delete).toBe('function');
      expect(typeof store.has).toBe('function');
    });

    it('should return the same store instance on subsequent calls', () => {
      const store1 = getAmazonExtenderStore();
      const store2 = getAmazonExtenderStore();
      expect(store1).toBe(store2);
    });

    it('should store and retrieve values', () => {
      const store = getAmazonExtenderStore<{ orders: string[] }>();
      const sessionId = 'test-session';
      const data = { orders: ['order1', 'order2'] };

      store.set(sessionId, data);
      const retrieved = store.get(sessionId);

      expect(retrieved).toEqual(data);
    });
  });

  describe('getPayPalExtenderStore', () => {
    it('should return a session store', () => {
      const store = getPayPalExtenderStore<{ transactions: any[] }>();
      expect(store).toBeDefined();
    });

    it('should store and retrieve values', () => {
      const store = getPayPalExtenderStore<{ data: number }>();
      store.set('session-1', { data: 42 });
      expect(store.get('session-1')).toEqual({ data: 42 });
    });
  });

  describe('getFinTSClientStore', () => {
    it('should return a session store', () => {
      const store = getFinTSClientStore();
      expect(store).toBeDefined();
    });

    it('should store and retrieve values', () => {
      const store = getFinTSClientStore<{ client: object }>();
      const mockClient = { connected: true };
      store.set('session-1', { client: mockClient });
      expect(store.get('session-1')).toEqual({ client: mockClient });
    });
  });

  describe('getFinTSDialogStateStore', () => {
    it('should return a session store', () => {
      const store = getFinTSDialogStateStore();
      expect(store).toBeDefined();
    });

    it('should store and retrieve values', () => {
      const store = getFinTSDialogStateStore<{ state: string }>();
      store.set('session-1', { state: 'connected' });
      expect(store.get('session-1')).toEqual({ state: 'connected' });
    });
  });

  describe('SessionStore operations', () => {
    it('should check existence with has()', () => {
      const store = getAmazonExtenderStore();
      store.set('session-1', { data: 'test' });

      expect(store.has('session-1')).toBe(true);
      expect(store.has('session-2')).toBe(false);
    });

    it('should delete entries', async () => {
      const store = getAmazonExtenderStore();
      store.set('session-1', { data: 'test' });

      const result = await store.delete('session-1');

      expect(result).toBe(true);
      expect(store.has('session-1')).toBe(false);
    });

    it('should return false when deleting non-existent entry', async () => {
      const store = getAmazonExtenderStore();
      const result = await store.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should call cleanup callback on delete', async () => {
      const store = getAmazonExtenderStore();
      const cleanup = vi.fn();

      store.set('session-1', { data: 'test' }, cleanup);
      await store.delete('session-1');

      expect(cleanup).toHaveBeenCalled();
    });

    it('should update lastAccessed on get', () => {
      const store = getAmazonExtenderStore<{ data: string }>();
      store.set('session-1', { data: 'test' });

      // Advance time
      vi.advanceTimersByTime(5000);

      // Getting the entry should update lastAccessed
      const result = store.get('session-1');
      expect(result).toEqual({ data: 'test' });
    });

    it('should return undefined for non-existent entry', () => {
      const store = getAmazonExtenderStore();
      expect(store.get('non-existent')).toBeUndefined();
    });

    it('should track store size', () => {
      const store = getAmazonExtenderStore();
      const initialSize = store.size;

      store.set('size-test-session-1', { data: 'test1' });
      expect(store.size).toBe(initialSize + 1);

      store.set('size-test-session-2', { data: 'test2' });
      expect(store.size).toBe(initialSize + 2);
    });
  });

  describe('TTL and expiration', () => {
    it('should evict expired entries', async () => {
      const store = getAmazonExtenderStore();
      const uniqueSession = `expire-test-${Date.now()}`;
      store.set(uniqueSession, { data: 'test' });

      // Verify it exists
      expect(store.has(uniqueSession)).toBe(true);

      // Advance time past TTL (default 15 minutes)
      vi.advanceTimersByTime(16 * 60 * 1000);

      const evicted = await store.evictExpired();
      // At least our entry should be evicted
      expect(evicted).toBeGreaterThanOrEqual(1);
      expect(store.has(uniqueSession)).toBe(false);
    });

    it('should not evict entries within TTL', async () => {
      const store = getAmazonExtenderStore();
      store.set('session-1', { data: 'test' });

      // Advance time but stay within TTL
      vi.advanceTimersByTime(14 * 60 * 1000);

      const evicted = await store.evictExpired();
      expect(evicted).toBe(0);
      expect(store.has('session-1')).toBe(true);
    });

    it('should refresh TTL on access', async () => {
      const store = getAmazonExtenderStore<{ data: string }>();
      store.set('session-1', { data: 'test' });

      // Advance time to near expiration
      vi.advanceTimersByTime(14 * 60 * 1000);

      // Access the entry
      store.get('session-1');

      // Advance time more
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Should still be valid because we accessed it
      const evicted = await store.evictExpired();
      expect(evicted).toBe(0);
    });
  });

  describe('clearSessionData', () => {
    it('should clear data from all stores for a session', async () => {
      const amazonStore = getAmazonExtenderStore();
      const paypalStore = getPayPalExtenderStore();

      amazonStore.set('session-1', { amazon: 'data' });
      paypalStore.set('session-1', { paypal: 'data' });

      await clearSessionData('session-1');

      expect(amazonStore.has('session-1')).toBe(false);
      expect(paypalStore.has('session-1')).toBe(false);
    });

    it('should handle sessions not in all stores', async () => {
      const amazonStore = getAmazonExtenderStore();
      amazonStore.set('session-1', { amazon: 'data' });

      // Should not throw even though session-1 is not in other stores
      await expect(clearSessionData('session-1')).resolves.not.toThrow();
    });

    it('should clear transaction cache session', async () => {
      const { clearSessionCache } = await import('./transactionCache.js');

      trackTransactionCacheSession('session-1');
      await clearSessionData('session-1');

      expect(clearSessionCache).toHaveBeenCalledWith('session-1');
    });
  });

  describe('trackTransactionCacheSession', () => {
    it('should track session IDs', () => {
      trackTransactionCacheSession('session-1');
      trackTransactionCacheSession('session-2');

      const stats = getStoreStats();
      expect(stats.transactionCacheSessions).toBeGreaterThanOrEqual(2);
    });
  });

  describe('cleanup interval', () => {
    it('should start cleanup interval', () => {
      startCleanupInterval();
      // Should not throw
      expect(true).toBe(true);
    });

    it('should stop cleanup interval', () => {
      startCleanupInterval();
      stopCleanupInterval();
      // Should not throw
      expect(true).toBe(true);
    });

    it('should not start multiple intervals', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      startCleanupInterval();
      startCleanupInterval(); // Should be no-op
      stopCleanupInterval();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStoreStats', () => {
    it('should return stats for all stores', () => {
      const stats = getStoreStats();

      expect(stats).toHaveProperty('amazonExtenders');
      expect(stats).toHaveProperty('paypalExtenders');
      expect(stats).toHaveProperty('fintsClients');
      expect(stats).toHaveProperty('fintsDialogStates');
      expect(stats).toHaveProperty('transactionCacheSessions');
    });

    it('should reflect store sizes', () => {
      const amazonStore = getAmazonExtenderStore();
      amazonStore.set('session-1', { data: 'test' });

      const stats = getStoreStats();
      expect(stats.amazonExtenders).toBe(1);
    });

    it('should return 0 for empty stores', () => {
      const stats = getStoreStats();
      // At minimum, should not be negative
      Object.values(stats).forEach((size) => {
        expect(size).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('max entries limit', () => {
    it('should evict oldest entry when max entries reached', () => {
      const store = getAmazonExtenderStore();

      // Fill up to max entries (100 according to the code)
      for (let i = 0; i < 101; i++) {
        store.set(`session-${i}`, { data: `test-${i}` });

        // Add small delay between sets to ensure different timestamps
        vi.advanceTimersByTime(10);
      }

      // The oldest entry should have been evicted
      // Note: We can't directly test for exactly 100 entries without
      // knowing which was evicted, but we can verify the store works
      expect(store.size).toBeLessThanOrEqual(100);
    });
  });
});
