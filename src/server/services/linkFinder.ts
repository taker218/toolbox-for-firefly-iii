import { v4 as uuidv4 } from 'uuid';
import { FireflyApiClient } from '../clients/firefly.js';
import { createLogger } from '../utils/logger.js';
import type { FireflyTransaction, FireflyTransactionSplit } from '../../shared/types/firefly.js';
import type {
  LinkCandidate,
  LinkConfidenceBreakdown,
  LinkDetector,
  LinkFinderOptions,
  LinkTypeInfo,
  LinkedJournal,
} from '../../shared/types/app.js';
import type { StreamEvent } from './duplicateFinder.js';

const logger = createLogger('LinkFinderService');

const DAY_MS = 1000 * 60 * 60 * 24;
const AMOUNT_EPSILON = 0.01;
const MIN_COUNTERPARTY_SIMILARITY = 0.5;
/** References shared by more journals than this are treated as non-unique (e.g. customer numbers) */
const MAX_REFERENCE_GROUP_SIZE = 6;

// Weights (summed and capped at 100%)
const WEIGHTS = {
  reference: { structured: 0.4, amazon: 0.4, paypal: 0.35, invoice: 0.3 },
  exactAmount: 0.35,
  partialAmount: 0.15,
  counterparty: 0.3,
  keyword: 0.2,
  dateProximity: 0.1,
  sameAccount: 0.05,
} as const;

/** Normalized (umlauts transliterated) keywords indicating a refund */
const REFUND_KEYWORDS = [
  'erstatt',
  'gutschrift',
  'refund',
  'storno',
  'stornierung',
  'rueckbuchung',
  'retoure',
  'ruecksendung',
  'rueckzahlung',
  'rueckueberweisung',
  'ruecklastschrift',
  'rueckgabe',
  'reversal',
  'chargeback',
];

/** Legal forms and filler words ignored when comparing counterparties */
const COUNTERPARTY_STOPWORDS = new Set([
  'gmbh',
  'mbh',
  'ag',
  'se',
  'kg',
  'co',
  'ohg',
  'ug',
  'ev',
  'sarl',
  'sa',
  'eu',
  'ltd',
  'inc',
  'llc',
  'bv',
  'de',
  'www',
  'com',
  'europe',
  'payments',
  'services',
  'online',
  'germany',
  'deutschland',
]);

const IGNORED_REFERENCE_VALUES = new Set(['NOTPROVIDED', 'NONE', 'NULL', 'UNDEFINED']);

type ReferenceKind = keyof typeof WEIGHTS.reference;

interface Reference {
  kind: ReferenceKind;
  value: string;
}

interface JournalInfo {
  journal: LinkedJournal;
  type: FireflyTransactionSplit['type'];
  amount: number;
  currency: string;
  day: number;
  counterparty: string;
  counterpartyIban: string | null;
  assetAccountId: string;
  hasRefundKeyword: boolean;
  references: Reference[];
}

interface ScoredPair {
  inward: JournalInfo;
  outward: JournalInfo;
  detector: LinkDetector;
  breakdown: LinkConfidenceBreakdown;
  reasons: string[];
  isPartial: boolean;
  matchedReference?: string;
}

export interface CreateLinkRequest {
  inwardId: string;
  outwardId: string;
  linkTypeName: string;
  notes?: string;
}

export class LinkFinder {
  private readonly fireflyApi: FireflyApiClient;
  private readonly defaultOptions: Required<LinkFinderOptions> = {
    detectors: ['refund', 'reference'],
    maxDaysApart: 90,
    allowPartialAmount: true,
    minConfidence: 0.6,
  };
  private readonly similarityCache = new Map<string, number>();

  constructor(fireflyApi: FireflyApiClient) {
    this.fireflyApi = fireflyApi;
  }

  /**
   * Streaming search for related transactions
   * @param startDate - Start date for fetching transactions (ignored if cachedTransactions provided)
   * @param endDate - End date for fetching transactions (ignored if cachedTransactions provided)
   * @param options - Link finder options
   * @param cachedTransactions - Pre-fetched transactions to use instead of fetching from API
   */
  async *streamFindLinks(
    startDate?: string,
    endDate?: string,
    options?: LinkFinderOptions,
    cachedTransactions?: FireflyTransaction[]
  ): AsyncGenerator<StreamEvent> {
    const opts = { ...this.defaultOptions, ...options };

    logger.debug('Starting link finding stream', {
      opts,
      range: { startDate, endDate },
      hasCache: !!cachedTransactions,
    });

    let transactions: FireflyTransaction[];
    if (cachedTransactions) {
      transactions = cachedTransactions;
    } else {
      yield {
        type: 'progress',
        data: { current: 0, total: 0, message: 'Fetching transactions...' },
      };
      transactions = await this.fireflyApi.getAllTransactions(startDate, endDate);
      logger.info(`Fetched ${transactions.length} transactions from API`);
    }

    yield {
      type: 'progress',
      data: { current: 0, total: 0, message: 'Loading existing links...' },
    };
    const existingLinks = await this.fireflyApi.getAllTransactionLinks();
    const linkedPairs = new Set(
      existingLinks.map((l) => pairKey(l.attributes.inward_id, l.attributes.outward_id))
    );

    const journals = this.toJournalInfos(transactions);
    const pairs: ScoredPair[] = [];

    if (opts.detectors.includes('refund')) {
      yield* this.detectRefunds(journals, opts, pairs);
    }

    if (opts.detectors.includes('reference')) {
      yield {
        type: 'progress',
        data: { current: 0, total: 0, message: 'Matching shared references...' },
      };
      pairs.push(...this.detectReferences(journals, opts));
    }

    const candidates = this.mergePairs(pairs)
      .filter((c) => !linkedPairs.has(pairKey(c.inward.journalId, c.outward.journalId)))
      .filter((c) => c.matchScore >= opts.minConfidence)
      .sort((a, b) => b.matchScore - a.matchScore);

    for (const candidate of candidates) {
      yield { type: 'result', data: candidate };
    }

    yield { type: 'complete', data: { total: candidates.length } };
  }

  async findLinks(
    startDate?: string,
    endDate?: string,
    options?: LinkFinderOptions
  ): Promise<LinkCandidate[]> {
    const candidates: LinkCandidate[] = [];
    for await (const event of this.streamFindLinks(startDate, endDate, options)) {
      if (event.type === 'result') {
        candidates.push(event.data as LinkCandidate);
      }
    }
    return candidates;
  }

  async getLinkTypes(): Promise<LinkTypeInfo[]> {
    const linkTypes = await this.fireflyApi.getAllLinkTypes();
    return linkTypes.map((lt) => ({
      id: lt.id,
      name: lt.attributes.name,
      inward: lt.attributes.inward,
      outward: lt.attributes.outward,
    }));
  }

  async createLinks(links: CreateLinkRequest[]): Promise<{
    successful: CreateLinkRequest[];
    failed: { link: CreateLinkRequest; error: string }[];
  }> {
    const linkTypes = await this.getLinkTypes();
    const results = {
      successful: [] as CreateLinkRequest[],
      failed: [] as { link: CreateLinkRequest; error: string }[],
    };

    for (const link of links) {
      const linkType = linkTypes.find(
        (lt) => lt.name.toLowerCase() === link.linkTypeName.toLowerCase()
      );
      if (!linkType) {
        results.failed.push({ link, error: `Unknown link type "${link.linkTypeName}"` });
        continue;
      }

      try {
        await this.fireflyApi.createTransactionLink({
          linkTypeId: linkType.id,
          inwardId: link.inwardId,
          outwardId: link.outwardId,
          notes: link.notes,
        });
        results.successful.push(link);
      } catch (error) {
        results.failed.push({
          link,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  // ============ Refund detection ============

  /**
   * Pairs deposits with earlier withdrawals at the same counterparty.
   * Each deposit is linked at most once; partial refunds may not exceed the original amount.
   */
  private *detectRefunds(
    journals: JournalInfo[],
    opts: Required<LinkFinderOptions>,
    out: ScoredPair[]
  ): Generator<StreamEvent> {
    const withdrawals = journals
      .filter((j) => j.type === 'withdrawal')
      .sort((a, b) => a.day - b.day);
    const deposits = journals.filter((j) => j.type === 'deposit');
    const total = deposits.length;
    const scored: ScoredPair[] = [];

    for (let i = 0; i < deposits.length; i++) {
      if (i % 25 === 0 || i === deposits.length - 1) {
        yield {
          type: 'progress',
          data: {
            current: i + 1,
            total,
            message: `Checking deposit ${i + 1} of ${total} for refunds...`,
          },
        };
      }

      const deposit = deposits[i];
      for (const withdrawal of withdrawals) {
        if (withdrawal.day > deposit.day) break;
        if (deposit.day - withdrawal.day > opts.maxDaysApart) continue;

        const pair = this.scoreRefund(withdrawal, deposit, opts);
        if (pair) scored.push(pair);
      }
    }

    // Greedy assignment, best matches first
    scored.sort((a, b) => totalScore(b.breakdown) - totalScore(a.breakdown));
    const usedDeposits = new Set<string>();
    const remaining = new Map<string, number>();

    for (const pair of scored) {
      if (totalScore(pair.breakdown) < opts.minConfidence) break;
      if (usedDeposits.has(pair.outward.journal.journalId)) continue;

      const left = remaining.get(pair.inward.journal.journalId) ?? pair.inward.amount;
      if (pair.outward.amount > left + AMOUNT_EPSILON) continue;

      usedDeposits.add(pair.outward.journal.journalId);
      remaining.set(pair.inward.journal.journalId, left - pair.outward.amount);
      out.push(pair);
    }
  }

  private scoreRefund(
    withdrawal: JournalInfo,
    deposit: JournalInfo,
    opts: Required<LinkFinderOptions>
  ): ScoredPair | null {
    if (withdrawal.currency !== deposit.currency) return null;

    const breakdown = emptyBreakdown();
    const reasons: string[] = [];

    const isExact = Math.abs(withdrawal.amount - deposit.amount) <= AMOUNT_EPSILON;
    const isPartial = !isExact && deposit.amount < withdrawal.amount;
    if (isExact) {
      breakdown.amountMatch = WEIGHTS.exactAmount;
      reasons.push('Same amount');
    } else if (isPartial && opts.allowPartialAmount) {
      breakdown.amountMatch = WEIGHTS.partialAmount;
      reasons.push('Partial amount');
    } else {
      return null;
    }

    const similarity = this.counterpartySimilarity(withdrawal, deposit);
    if (similarity < MIN_COUNTERPARTY_SIMILARITY) return null;
    breakdown.counterpartyMatch = WEIGHTS.counterparty * similarity;
    reasons.push(similarity === 1 ? 'Same counterparty' : 'Similar counterparty');

    this.applyCommonSignals(withdrawal, deposit, opts, breakdown, reasons);

    return {
      inward: withdrawal,
      outward: deposit,
      detector: 'refund',
      breakdown,
      reasons,
      isPartial,
    };
  }

  // ============ Reference detection ============

  private detectReferences(
    journals: JournalInfo[],
    opts: Required<LinkFinderOptions>
  ): ScoredPair[] {
    const index = new Map<string, { reference: Reference; journals: JournalInfo[] }>();
    for (const journal of journals) {
      for (const reference of journal.references) {
        const key = `${reference.kind}:${reference.value}`;
        const entry = index.get(key) ?? { reference, journals: [] };
        if (!entry.journals.includes(journal)) entry.journals.push(journal);
        index.set(key, entry);
      }
    }

    const pairs: ScoredPair[] = [];
    for (const { reference, journals: group } of index.values()) {
      if (group.length < 2 || group.length > MAX_REFERENCE_GROUP_SIZE) continue;

      const sorted = [...group].sort((a, b) => a.day - b.day);
      const [anchor, ...others] = sorted;
      for (const other of others) {
        if (other.journal.transactionId === anchor.journal.transactionId) continue;
        if (this.looksLikeDuplicate(anchor, other)) continue;
        pairs.push(this.scoreReference(anchor, other, reference, opts));
      }
    }
    return pairs;
  }

  private scoreReference(
    inward: JournalInfo,
    outward: JournalInfo,
    reference: Reference,
    opts: Required<LinkFinderOptions>
  ): ScoredPair {
    const breakdown = emptyBreakdown();
    const reasons: string[] = [`Shared reference ${reference.value}`];
    breakdown.referenceMatch = WEIGHTS.reference[reference.kind];

    let isPartial = false;
    if (inward.currency === outward.currency) {
      if (Math.abs(inward.amount - outward.amount) <= AMOUNT_EPSILON) {
        breakdown.amountMatch = WEIGHTS.exactAmount;
        reasons.push('Same amount');
      } else if (opts.allowPartialAmount && outward.amount < inward.amount) {
        breakdown.amountMatch = WEIGHTS.partialAmount;
        reasons.push('Partial amount');
        isPartial = true;
      }
    }

    const similarity = this.counterpartySimilarity(inward, outward);
    if (similarity >= MIN_COUNTERPARTY_SIMILARITY) {
      breakdown.counterpartyMatch = WEIGHTS.counterparty * similarity;
      reasons.push(similarity === 1 ? 'Same counterparty' : 'Similar counterparty');
    }

    this.applyCommonSignals(inward, outward, opts, breakdown, reasons);

    return {
      inward,
      outward,
      detector: 'reference',
      breakdown,
      reasons,
      isPartial,
      matchedReference: reference.value,
    };
  }

  /** Same reference, type and amount within a few days is a duplicate, not a link */
  private looksLikeDuplicate(a: JournalInfo, b: JournalInfo): boolean {
    return (
      a.type === b.type &&
      Math.abs(a.amount - b.amount) <= AMOUNT_EPSILON &&
      Math.abs(a.day - b.day) <= 3
    );
  }

  // ============ Shared scoring ============

  private applyCommonSignals(
    inward: JournalInfo,
    outward: JournalInfo,
    opts: Required<LinkFinderOptions>,
    breakdown: LinkConfidenceBreakdown,
    reasons: string[]
  ): void {
    if (outward.hasRefundKeyword) {
      breakdown.keywordMatch = WEIGHTS.keyword;
      reasons.push('Refund keyword');
    }

    const daysApart = Math.abs(outward.day - inward.day);
    if (daysApart <= opts.maxDaysApart) {
      breakdown.dateProximity = WEIGHTS.dateProximity * (1 - daysApart / (opts.maxDaysApart + 1));
      reasons.push(`${daysApart} day(s) apart`);
    }

    if (inward.assetAccountId && inward.assetAccountId === outward.assetAccountId) {
      breakdown.sameAccount = WEIGHTS.sameAccount;
      reasons.push('Same account');
    }
  }

  private mergePairs(pairs: ScoredPair[]): LinkCandidate[] {
    const merged = new Map<string, LinkCandidate>();

    for (const pair of pairs) {
      const key = pairKey(pair.inward.journal.journalId, pair.outward.journal.journalId);
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          id: uuidv4(),
          detectors: [pair.detector],
          inward: pair.inward.journal,
          outward: pair.outward.journal,
          suggestedLinkType: suggestLinkType(pair.inward, pair.outward),
          isPartial: pair.isPartial,
          matchedReference: pair.matchedReference,
          matchScore: totalScore(pair.breakdown),
          matchReasons: [...pair.reasons],
          confidenceBreakdown: { ...pair.breakdown },
        });
        continue;
      }

      if (!existing.detectors.includes(pair.detector)) existing.detectors.push(pair.detector);
      existing.matchedReference ??= pair.matchedReference;
      existing.matchReasons = [...new Set([...existing.matchReasons, ...pair.reasons])];
      for (const field of Object.keys(pair.breakdown) as (keyof LinkConfidenceBreakdown)[]) {
        existing.confidenceBreakdown[field] = Math.max(
          existing.confidenceBreakdown[field],
          pair.breakdown[field]
        );
      }
      existing.matchScore = totalScore(existing.confidenceBreakdown);
    }

    return [...merged.values()];
  }

  // ============ Journal preparation ============

  private toJournalInfos(transactions: FireflyTransaction[]): JournalInfo[] {
    const journals: JournalInfo[] = [];

    for (const transaction of transactions) {
      for (const split of transaction.attributes.transactions) {
        if (!['withdrawal', 'deposit', 'transfer'].includes(split.type)) continue;

        const isDeposit = split.type === 'deposit';
        const text = normalizeText(`${split.description ?? ''}\n${split.notes ?? ''}`);
        const counterpartyName = isDeposit ? split.source_name : split.destination_name;

        journals.push({
          journal: {
            transactionId: transaction.id,
            journalId: split.transaction_journal_id,
            split,
          },
          type: split.type,
          amount: Math.abs(Number.parseFloat(split.amount)),
          currency: split.currency_code,
          day: toDay(split.date),
          counterparty: split.type === 'transfer' ? '' : normalizeText(counterpartyName),
          counterpartyIban: normalizeIban(isDeposit ? split.source_iban : split.destination_iban),
          assetAccountId: isDeposit ? split.destination_id : split.source_id,
          hasRefundKeyword: REFUND_KEYWORDS.some((k) => text.includes(k)),
          references: extractReferences(split),
        });
      }
    }

    return journals;
  }

  private counterpartySimilarity(a: JournalInfo, b: JournalInfo): number {
    if (a.counterpartyIban && a.counterpartyIban === b.counterpartyIban) return 1;
    if (!a.counterparty || !b.counterparty) return 0;

    const cacheKey =
      a.counterparty < b.counterparty
        ? `${a.counterparty}|${b.counterparty}`
        : `${b.counterparty}|${a.counterparty}`;
    const cached = this.similarityCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const similarity = calculateNameSimilarity(a.counterparty, b.counterparty);
    this.similarityCache.set(cacheKey, similarity);
    return similarity;
  }
}

// ============ Helpers ============

function pairKey(journalA: string, journalB: string): string {
  return journalA < journalB ? `${journalA}|${journalB}` : `${journalB}|${journalA}`;
}

function emptyBreakdown(): LinkConfidenceBreakdown {
  return {
    referenceMatch: 0,
    amountMatch: 0,
    counterpartyMatch: 0,
    keywordMatch: 0,
    dateProximity: 0,
    sameAccount: 0,
  };
}

function totalScore(breakdown: LinkConfidenceBreakdown): number {
  const sum = Object.values(breakdown).reduce((acc, value) => acc + value, 0);
  return Math.min(1, sum);
}

function suggestLinkType(inward: JournalInfo, outward: JournalInfo): string {
  return inward.type === 'withdrawal' && outward.type === 'deposit' ? 'Refund' : 'Related';
}

/** Calendar day index (ignores time of day and timezone offsets) */
function toDay(date: string): number {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss');
}

function normalizeIban(iban: string | null): string | null {
  const normalized = iban?.replace(/\s/g, '').toUpperCase();
  return normalized || null;
}

function tokenize(name: string): string[] {
  return name
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !COUNTERPARTY_STOPWORDS.has(token));
}

/**
 * Similarity of two normalized counterparty names (0-1).
 * Uses token overlap so "amazon" matches "amazon eu s.a.r.l." and falls back to Levenshtein.
 */
export function calculateNameSimilarity(a: string, b: string): number {
  if (a === b) return 1;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setB = new Set(tokensB);
  const shared = [...new Set(tokensA)].filter((t) => setB.has(t)).length;
  const overlap = shared / Math.min(new Set(tokensA).size, setB.size);
  if (overlap === 1) return tokensA.join(' ') === tokensB.join(' ') ? 1 : 0.9;

  const joinedA = tokensA.join(' ');
  const joinedB = tokensB.join(' ');
  const longer = joinedA.length >= joinedB.length ? joinedA : joinedB;
  const shorter = joinedA.length >= joinedB.length ? joinedB : joinedA;
  const levenshtein = (longer.length - levenshteinDistance(longer, shorter)) / longer.length;

  return Math.max(overlap * 0.8, levenshtein);
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs: number[] = [];

  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) {
      costs[s2.length] = lastValue;
    }
  }

  return costs[s2.length];
}

const AMAZON_ORDER_PATTERN = /\b\d{3}-\d{7}-\d{7}\b/g;
const PAYPAL_ID_PATTERN = /\b(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{17}\b/g;
const INVOICE_PATTERN =
  /(?:rechnungsnummer|rechnungsnr|rechnung|re-nr|renr|invoice number|invoice no|invoice)(?:[\s:#.]{1,3}nr)?[\s:#.]{0,3}([a-z0-9][a-z0-9/-]{3,30})/gi;

/** Collects reference IDs from structured fields and free text */
export function extractReferences(split: FireflyTransactionSplit): Reference[] {
  const references: Reference[] = [];
  const add = (kind: ReferenceKind, raw: string | null | undefined) => {
    const value = raw?.trim().toUpperCase();
    if (!value || value.length < 6 || IGNORED_REFERENCE_VALUES.has(value)) return;
    if (/^0+$/.test(value)) return;
    if (!references.some((r) => r.kind === kind && r.value === value)) {
      references.push({ kind, value });
    }
  };

  add('structured', split.external_id);
  add('structured', split.internal_reference);
  add('structured', split.sepa_ct_id);

  const text = `${split.description ?? ''}\n${split.notes ?? ''}`;
  for (const match of text.matchAll(AMAZON_ORDER_PATTERN)) add('amazon', match[0]);
  if (/paypal/i.test(text)) {
    for (const match of text.matchAll(PAYPAL_ID_PATTERN)) add('paypal', match[0]);
  }
  for (const match of text.matchAll(INVOICE_PATTERN)) {
    if (/\d/.test(match[1])) add('invoice', match[1]);
  }

  return references;
}
