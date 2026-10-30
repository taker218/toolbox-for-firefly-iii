import { ref, type Ref } from 'vue';
import type { FireflyTransactionSplit } from '@shared/types/firefly';
import api from '../services/api';

export interface TransactionPreviewState {
  /** Number of transactions matching the filter */
  count: Ref<number | null>;
  /** Preview transactions for display */
  transactions: Ref<FireflyTransactionSplit[]>;
  /** Whether initial count is being fetched */
  fetching: Ref<boolean>;
  /** Whether more transactions are being loaded */
  loadingMore: Ref<boolean>;
  /** Fetch transaction count and initial preview */
  fetchCount: (endpoint: string, params: Record<string, unknown>) => Promise<void>;
  /** Load more transactions for preview */
  loadMore: (endpoint: string, params: Record<string, unknown>) => Promise<void>;
  /** Re-run the last fetchCount, bypassing client and server caches */
  refresh: () => Promise<void>;
  /** Clear cache and reset state */
  reset: () => void;
  /** Get cache key for given params */
  getCacheKey: (startDate?: string, endDate?: string, extra?: string) => string;
}

interface CacheEntry {
  count: number;
  transactions: FireflyTransactionSplit[];
}

const PREVIEW_LIMIT = 50;

/**
 * Composable for managing transaction preview state with caching
 */
export function useTransactionPreview(): TransactionPreviewState {
  const count = ref<number | null>(null);
  const transactions = ref<FireflyTransactionSplit[]>([]);
  const fetching = ref(false);
  const loadingMore = ref(false);

  // Cache keyed by params
  const cache = new Map<string, CacheEntry>();

  // Last fetchCount call, used by refresh()
  let lastRequest: { endpoint: string; params: Record<string, unknown> } | null = null;

  function getCacheKey(startDate?: string, endDate?: string, extra?: string): string {
    return `${startDate || ''}-${endDate || ''}-${extra || ''}`;
  }

  async function fetchCount(endpoint: string, params: Record<string, unknown>): Promise<void> {
    lastRequest = { endpoint, params };
    const cacheKey = getCacheKey(
      params.startDate as string | undefined,
      params.endDate as string | undefined,
      params.extra as string | undefined
    );

    // Check cache first
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey)!;
      count.value = cached.count;
      transactions.value = cached.transactions;
      return;
    }

    fetching.value = true;

    try {
      const response = await api.post(endpoint, {
        ...params,
        limit: PREVIEW_LIMIT,
        offset: 0,
      });

      const data = response.data.data;
      cache.set(cacheKey, {
        count: data.count,
        transactions: data.transactions,
      });
      count.value = data.count;
      transactions.value = data.transactions;
    } catch (error) {
      console.error('Failed to fetch transaction count:', error);
      count.value = null;
      transactions.value = [];
    } finally {
      fetching.value = false;
    }
  }

  async function loadMore(endpoint: string, params: Record<string, unknown>): Promise<void> {
    if (loadingMore.value || count.value === null) return;
    if (transactions.value.length >= count.value) return;

    loadingMore.value = true;

    try {
      const response = await api.post(endpoint, {
        ...params,
        limit: PREVIEW_LIMIT,
        offset: transactions.value.length,
      });

      const newTransactions = response.data.data.transactions;
      transactions.value = [...transactions.value, ...newTransactions];

      // Update cache
      const cacheKey = getCacheKey(
        params.startDate as string | undefined,
        params.endDate as string | undefined,
        params.extra as string | undefined
      );
      cache.set(cacheKey, {
        count: count.value,
        transactions: transactions.value,
      });
    } catch (error) {
      console.error('Failed to load more transactions:', error);
    } finally {
      loadingMore.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (!lastRequest || fetching.value) return;

    cache.clear();
    transactions.value = [];
    const { endpoint, params } = lastRequest;
    await fetchCount(endpoint, { ...params, refresh: true });
    // Keep the flag out of later loadMore/refresh calls
    lastRequest = { endpoint, params };
  }

  function reset(): void {
    lastRequest = null;
    cache.clear();
    count.value = null;
    transactions.value = [];
    fetching.value = false;
    loadingMore.value = false;
  }

  return {
    count,
    transactions,
    fetching,
    loadingMore,
    fetchCount,
    loadMore,
    refresh,
    reset,
    getCacheKey,
  };
}
