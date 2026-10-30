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
  unusualAmount: 0.15,
  uniqueAmount: 0.1,
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

/** Normalized keywords indicating a reimbursement of expenses (e.g. by an employer) */
const REIMBURSEMENT_KEYWORDS = [
  'erstatt',
  'auslage',
  'spesen',
  'reisekosten',
  'kostenerstattung',
  'auslagenersatz',
  'reimburse',
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
  hasReimbursementKeyword: boolean;
  references: Reference[];
}

interface ScoredPair {
  original: JournalInfo;
  related: JournalInfo;
  detector: LinkDetector;
  linkType: string;
  breakdown: LinkConfidenceBreakdown;
  reasons: string[];
  isPartial: boolean;
  matchedReference?: string;
}

/** Deposits and withdrawal amounts already assigned by an amount-based detector */
interface AmountClaims {
  usedDeposits: Set<string>;
  remaining: Map<string, number>;
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
    detectors: ['refund', 'reimbursement', 'reference'],
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
    // Shared so a deposit is used either as refund or as reimbursement, never both
    const claims: AmountClaims = { usedDeposits: new Set(), remaining: new Map() };

    if (opts.detectors.includes('refund')) {
      yield* this.detectRefunds(journals, opts, claims, pairs);
    }

    if (opts.detectors.includes('reimbursement')) {
      yield {
        type: 'progress',
        data: { current: 0, total: 0, message: 'Matching reimbursements...' },
      };
      this.detectReimbursements(journals, opts, claims, pairs);
    }

    if (opts.detectors.includes('reference')) {
      yield {
        type: 'progress',
        data: { current: 0, total: 0, message: 'Matching shared references...' },
      };
      pairs.push(...this.detectReferences(journals, opts));
    }

    const candidates = this.mergePairs(pairs)
      .filter((c) => !linkedPairs.has(pairKey(c.original.journalId, c.related.journalId)))
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
    claims: AmountClaims,
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

    assignByAmount(scored, opts, claims, out);
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
      original: withdrawal,
      related: deposit,
      detector: 'refund',
      linkType: 'Refund',
      breakdown,
      reasons,
      isPartial,
    };
  }

  // ============ Reimbursement detection ============

  /**
   * Pairs deposits with earlier withdrawals of exactly the same amount at a different
   * counterparty (e.g. expenses paid privately and reimbursed by the employer).
   * As the amount is the main signal, round or ambiguous amounts require a reimbursement keyword.
   */
  private detectReimbursements(
    journals: JournalInfo[],
    opts: Required<LinkFinderOptions>,
    claims: AmountClaims,
    out: ScoredPair[]
  ): void {
    const withdrawalsByAmount = groupByAmount(journals.filter((j) => j.type === 'withdrawal'));
    const depositsByAmount = groupByAmount(journals.filter((j) => j.type === 'deposit'));
    const scored: ScoredPair[] = [];

    for (const [key, deposits] of depositsByAmount) {
      const withdrawals = withdrawalsByAmount.get(key) ?? [];
      for (const deposit of deposits) {
        const matches = withdrawals.filter(
          (w) => w.day <= deposit.day && deposit.day - w.day <= opts.maxDaysApart
        );
        for (const withdrawal of matches) {
          const competingDeposits = deposits.filter(
            (d) => d.day >= withdrawal.day && d.day - withdrawal.day <= opts.maxDaysApart
          );
          const isUnique = matches.length === 1 && competingDeposits.length === 1;
          const pair = this.scoreReimbursement(withdrawal, deposit, isUnique, opts);
          if (pair) scored.push(pair);
        }
      }
    }

    assignByAmount(scored, opts, claims, out);
  }

  private scoreReimbursement(
    withdrawal: JournalInfo,
    deposit: JournalInfo,
    isUnique: boolean,
    opts: Required<LinkFinderOptions>
  ): ScoredPair | null {
    // Same counterparty is a refund, not a reimbursement
    if (this.counterpartySimilarity(withdrawal, deposit) >= MIN_COUNTERPARTY_SIMILARITY) {
      return null;
    }
    // Without a keyword only unique, non-round amounts are distinctive enough
    const isUnusual = Math.round(withdrawal.amount * 100) % 100 !== 0;
    if (!(isUnique && isUnusual) && !deposit.hasReimbursementKeyword) return null;

    const breakdown = emptyBreakdown();
    const reasons: string[] = ['Same amount'];
    breakdown.amountMatch = WEIGHTS.exactAmount;

    if (isUnusual) {
      breakdown.unusualAmount = WEIGHTS.unusualAmount;
      reasons.push('Unusual amount');
    }
    if (isUnique) {
      breakdown.uniqueAmount = WEIGHTS.uniqueAmount;
      reasons.push('Unique amount in time window');
    }

    this.applyCommonSignals(
      withdrawal,
      deposit,
      opts,
      breakdown,
      reasons,
      deposit.hasReimbursementKeyword
    );

    return {
      original: withdrawal,
      related: deposit,
      detector: 'reimbursement',
      linkType: 'Reimbursement',
      breakdown,
      reasons,
      isPartial: false,
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
    original: JournalInfo,
    related: JournalInfo,
    reference: Reference,
    opts: Required<LinkFinderOptions>
  ): ScoredPair {
    const breakdown = emptyBreakdown();
    const reasons: string[] = [`Shared reference ${reference.value}`];
    breakdown.referenceMatch = WEIGHTS.reference[reference.kind];

    let isPartial = false;
    if (original.currency === related.currency) {
      if (Math.abs(original.amount - related.amount) <= AMOUNT_EPSILON) {
        breakdown.amountMatch = WEIGHTS.exactAmount;
        reasons.push('Same amount');
      } else if (opts.allowPartialAmount && related.amount < original.amount) {
        breakdown.amountMatch = WEIGHTS.partialAmount;
        reasons.push('Partial amount');
        isPartial = true;
      }
    }

    const similarity = this.counterpartySimilarity(original, related);
    if (similarity >= MIN_COUNTERPARTY_SIMILARITY) {
      breakdown.counterpartyMatch = WEIGHTS.counterparty * similarity;
      reasons.push(similarity === 1 ? 'Same counterparty' : 'Similar counterparty');
    }

    this.applyCommonSignals(original, related, opts, breakdown, reasons);

    return {
      original,
      related,
      detector: 'reference',
      linkType: suggestLinkType(original, related),
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
    original: JournalInfo,
    related: JournalInfo,
    opts: Required<LinkFinderOptions>,
    breakdown: LinkConfidenceBreakdown,
    reasons: string[],
    hasKeyword: boolean = related.hasRefundKeyword
  ): void {
    if (hasKeyword) {
      breakdown.keywordMatch = WEIGHTS.keyword;
      reasons.push('Keyword');
    }

    const daysApart = Math.abs(related.day - original.day);
    if (daysApart <= opts.maxDaysApart) {
      breakdown.dateProximity = WEIGHTS.dateProximity * (1 - daysApart / (opts.maxDaysApart + 1));
      reasons.push(`${daysApart} day(s) apart`);
    }

    if (original.assetAccountId && original.assetAccountId === related.assetAccountId) {
      breakdown.sameAccount = WEIGHTS.sameAccount;
      reasons.push('Same account');
    }
  }

  private mergePairs(pairs: ScoredPair[]): LinkCandidate[] {
    const merged = new Map<string, LinkCandidate>();

    for (const pair of pairs) {
      const key = pairKey(pair.original.journal.journalId, pair.related.journal.journalId);
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          id: uuidv4(),
          detectors: [pair.detector],
          original: pair.original.journal,
          related: pair.related.journal,
          suggestedLinkType: pair.linkType,
          isPartial: pair.isPartial,
          matchedReference: pair.matchedReference,
          matchScore: totalScore(pair.breakdown),
          matchReasons: [...pair.reasons],
          confidenceBreakdown: { ...pair.breakdown },
        });
        continue;
      }

      if (!existing.detectors.includes(pair.detector)) existing.detectors.push(pair.detector);
      // Prefer the more specific link type (e.g. "Reimbursement" over a reference's "Related")
      if (existing.suggestedLinkType === 'Related') existing.suggestedLinkType = pair.linkType;
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
          hasReimbursementKeyword: REIMBURSEMENT_KEYWORDS.some((k) => text.includes(k)),
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
    unusualAmount: 0,
    uniqueAmount: 0,
  };
}

/**
 * Greedy assignment, best matches first: each deposit is used once and the deposits linked
 * to a withdrawal may not exceed its amount (allows several partial refunds).
 */
function assignByAmount(
  scored: ScoredPair[],
  opts: Required<LinkFinderOptions>,
  claims: AmountClaims,
  out: ScoredPair[]
): void {
  scored.sort((a, b) => totalScore(b.breakdown) - totalScore(a.breakdown));

  for (const pair of scored) {
    if (totalScore(pair.breakdown) < opts.minConfidence) break;
    if (claims.usedDeposits.has(pair.related.journal.journalId)) continue;

    const left = claims.remaining.get(pair.original.journal.journalId) ?? pair.original.amount;
    if (pair.related.amount > left + AMOUNT_EPSILON) continue;

    claims.usedDeposits.add(pair.related.journal.journalId);
    claims.remaining.set(pair.original.journal.journalId, left - pair.related.amount);
    out.push(pair);
  }
}

function groupByAmount(journals: JournalInfo[]): Map<string, JournalInfo[]> {
  const groups = new Map<string, JournalInfo[]>();
  for (const journal of journals) {
    const key = `${journal.currency}:${Math.round(journal.amount * 100)}`;
    const group = groups.get(key) ?? [];
    group.push(journal);
    groups.set(key, group);
  }
  return groups;
}

function totalScore(breakdown: LinkConfidenceBreakdown): number {
  const sum = Object.values(breakdown).reduce((acc, value) => acc + value, 0);
  return Math.min(1, sum);
}

function suggestLinkType(original: JournalInfo, related: JournalInfo): string {
  return original.type === 'withdrawal' && related.type === 'deposit' ? 'Refund' : 'Related';
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
