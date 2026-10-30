import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkFinder, calculateNameSimilarity, extractReferences } from './linkFinder.js';
import type { FireflyTransaction, FireflyTransactionSplit } from '../../shared/types/firefly.js';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const ASSET_ACCOUNT = '1';

// Helper to create a mock transaction split
function createSplit(overrides: Partial<FireflyTransactionSplit>): FireflyTransactionSplit {
  return {
    user: '1',
    transaction_journal_id: '1',
    type: 'withdrawal',
    date: '2024-03-01T00:00:00+01:00',
    order: 0,
    currency_id: '1',
    currency_code: 'EUR',
    currency_symbol: '€',
    currency_decimal_places: 2,
    foreign_currency_id: null,
    foreign_currency_code: null,
    foreign_currency_symbol: null,
    foreign_currency_decimal_places: null,
    amount: '100.00',
    foreign_amount: null,
    description: 'Test transaction',
    source_id: ASSET_ACCOUNT,
    source_name: 'Checking Account',
    source_iban: null,
    source_type: 'Asset account',
    destination_id: '2',
    destination_name: 'Shop',
    destination_iban: null,
    destination_type: 'Expense account',
    budget_id: null,
    budget_name: null,
    category_id: null,
    category_name: null,
    bill_id: null,
    bill_name: null,
    reconciled: false,
    notes: null,
    tags: [],
    internal_reference: null,
    external_id: null,
    external_url: null,
    original_source: null,
    recurrence_id: null,
    recurrence_total: null,
    recurrence_count: null,
    bunq_payment_id: null,
    import_hash_v2: null,
    sepa_cc: null,
    sepa_ct_op: null,
    sepa_ct_id: null,
    sepa_db: null,
    sepa_country: null,
    sepa_ep: null,
    sepa_ci: null,
    sepa_batch_id: null,
    interest_date: null,
    book_date: null,
    process_date: null,
    due_date: null,
    payment_date: null,
    invoice_date: null,
    latitude: null,
    longitude: null,
    zoom_level: null,
    has_attachments: false,
    ...overrides,
  };
}

function wrap(id: string, split: FireflyTransactionSplit): FireflyTransaction {
  return {
    id,
    type: 'transactions',
    attributes: {
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      user: '1',
      group_title: null,
      transactions: [{ ...split, transaction_journal_id: id }],
    },
  };
}

function withdrawal(
  id: string,
  date: string,
  amount: string,
  merchant: string,
  extra: Partial<FireflyTransactionSplit> = {}
): FireflyTransaction {
  return wrap(
    id,
    createSplit({
      type: 'withdrawal',
      date,
      amount,
      description: `Purchase ${merchant}`,
      source_id: ASSET_ACCOUNT,
      destination_id: `exp-${merchant}`,
      destination_name: merchant,
      ...extra,
    })
  );
}

function deposit(
  id: string,
  date: string,
  amount: string,
  merchant: string,
  extra: Partial<FireflyTransactionSplit> = {}
): FireflyTransaction {
  return wrap(
    id,
    createSplit({
      type: 'deposit',
      date,
      amount,
      description: `Incoming ${merchant}`,
      source_id: `rev-${merchant}`,
      source_name: merchant,
      source_type: 'Revenue account',
      destination_id: ASSET_ACCOUNT,
      destination_name: 'Checking Account',
      destination_type: 'Asset account',
      ...extra,
    })
  );
}

describe('LinkFinder', () => {
  let mockFireflyApi: any;
  let finder: LinkFinder;

  beforeEach(() => {
    mockFireflyApi = {
      getAllTransactions: vi.fn().mockResolvedValue([]),
      getAllTransactionLinks: vi.fn().mockResolvedValue([]),
      getAllLinkTypes: vi.fn().mockResolvedValue([]),
      createTransactionLink: vi.fn().mockResolvedValue({}),
    };
    finder = new LinkFinder(mockFireflyApi);
  });

  describe('refund detection', () => {
    it('should link a full refund from the same merchant', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '49.99', 'Amazon EU S.a.r.l.'),
        deposit('2', '2024-03-10', '49.99', 'AMAZON PAYMENTS EUROPE', {
          description: 'Erstattung Bestellung',
        }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      expect(result[0].inward.journalId).toBe('1');
      expect(result[0].outward.journalId).toBe('2');
      expect(result[0].suggestedLinkType).toBe('Refund');
      expect(result[0].isPartial).toBe(false);
      expect(result[0].detectors).toEqual(['refund']);
      expect(result[0].matchScore).toBeGreaterThan(0.9);
    });

    it('should detect partial refunds with a refund keyword', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '100.00', 'Zalando SE'),
        deposit('2', '2024-03-15', '30.00', 'Zalando', { description: 'Gutschrift Retoure' }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      expect(result[0].isPartial).toBe(true);
      expect(result[0].confidenceBreakdown.keywordMatch).toBeGreaterThan(0);
    });

    it('should not detect partial refunds when disabled', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '100.00', 'Zalando SE'),
        deposit('2', '2024-03-15', '30.00', 'Zalando', { description: 'Gutschrift Retoure' }),
      ]);

      const result = await finder.findLinks(undefined, undefined, { allowPartialAmount: false });

      expect(result).toHaveLength(0);
    });

    it('should not let partial refunds exceed the original amount', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '50.00', 'Zalando'),
        deposit('2', '2024-03-05', '30.00', 'Zalando', { description: 'Erstattung 1' }),
        deposit('3', '2024-03-20', '30.00', 'Zalando', { description: 'Erstattung 2' }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      // The closer refund scores higher and wins
      expect(result[0].outward.journalId).toBe('2');
    });

    it('should allow several partial refunds up to the original amount', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '100.00', 'Zalando'),
        deposit('2', '2024-03-05', '30.00', 'Zalando', { description: 'Erstattung 1' }),
        deposit('3', '2024-03-20', '70.00', 'Zalando', { description: 'Erstattung 2' }),
      ]);

      const result = await finder.findLinks();

      expect(result.map((c) => c.outward.journalId).sort()).toEqual(['2', '3']);
    });

    it('should link each deposit to only one withdrawal', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '20.00', 'Zalando'),
        withdrawal('2', '2024-03-02', '20.00', 'Zalando'),
        deposit('3', '2024-03-10', '20.00', 'Zalando', { description: 'Erstattung' }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      expect(result[0].inward.journalId).toBe('2');
    });

    it('should ignore deposits before the withdrawal', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        deposit('1', '2024-02-20', '49.99', 'Amazon', { description: 'Erstattung' }),
        withdrawal('2', '2024-03-01', '49.99', 'Amazon'),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(0);
    });

    it('should ignore deposits outside the time window', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-01-01', '49.99', 'Amazon'),
        deposit('2', '2024-03-15', '49.99', 'Amazon', { description: 'Erstattung' }),
      ]);

      const result = await finder.findLinks(undefined, undefined, { maxDaysApart: 30 });

      expect(result).toHaveLength(0);
    });

    it('should ignore deposits from a different counterparty', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '49.99', 'REWE Markt GmbH'),
        deposit('2', '2024-03-10', '49.99', 'Arbeitgeber AG', { description: 'Erstattung' }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(0);
    });

    it('should match counterparties by IBAN', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '120.00', 'Stadtwerke', {
          destination_iban: 'DE89 3704 0044 0532 0130 00',
        }),
        deposit('2', '2024-03-10', '120.00', 'SWM Versorgung', {
          source_iban: 'DE89370400440532013000',
          description: 'Rückzahlung',
        }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      expect(result[0].confidenceBreakdown.counterpartyMatch).toBeCloseTo(0.3);
    });

    it('should skip pairs that are already linked', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '49.99', 'Amazon'),
        deposit('2', '2024-03-10', '49.99', 'Amazon', { description: 'Erstattung' }),
      ]);
      mockFireflyApi.getAllTransactionLinks.mockResolvedValue([
        {
          id: '9',
          type: 'transaction_links',
          attributes: { link_type_id: '1', inward_id: '2', outward_id: '1', notes: null },
        },
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(0);
    });

    it('should respect the minimum confidence', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '49.99', 'Amazon'),
        deposit('2', '2024-03-10', '49.99', 'Amazon'),
      ]);

      expect(await finder.findLinks()).toHaveLength(1);
      expect(await finder.findLinks(undefined, undefined, { minConfidence: 0.95 })).toHaveLength(0);
    });
  });

  describe('reference detection', () => {
    it('should combine refund and shared Amazon order ID', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '80.00', 'Amazon', {
          description: 'Amazon 302-1234567-7654321',
        }),
        deposit('2', '2024-03-12', '20.00', 'Amazon', {
          notes: 'Refund for order 302-1234567-7654321',
        }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      expect(result[0].detectors.sort()).toEqual(['reference', 'refund']);
      expect(result[0].matchedReference).toBe('302-1234567-7654321');
      expect(result[0].matchScore).toBe(1);
    });

    it('should link transactions sharing a SEPA end-to-end reference', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '59.00', 'Telekom', { sepa_ct_id: 'E2E-2024-000123' }),
        deposit('2', '2024-03-08', '59.00', 'Telekom Deutschland', {
          sepa_ct_id: 'E2E-2024-000123',
          description: 'Rücklastschrift',
        }),
      ]);

      const result = await finder.findLinks(undefined, undefined, { detectors: ['reference'] });

      expect(result).toHaveLength(1);
      expect(result[0].detectors).toEqual(['reference']);
      expect(result[0].suggestedLinkType).toBe('Refund');
    });

    it('should suggest "Related" for non-refund pairs', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '250.00', 'Handwerker Meier', {
          description: 'Abschlag Rechnung Nr. RE-2024-0815',
        }),
        withdrawal('2', '2024-04-01', '120.00', 'Handwerker Meier', {
          description: 'Restzahlung Rechnung Nr. RE-2024-0815',
        }),
      ]);

      const result = await finder.findLinks(undefined, undefined, { detectors: ['reference'] });

      expect(result).toHaveLength(1);
      expect(result[0].suggestedLinkType).toBe('Related');
    });

    it('should not link duplicates sharing a reference', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '59.00', 'Telekom', { external_id: 'TX-987654' }),
        withdrawal('2', '2024-03-02', '59.00', 'Telekom', { external_id: 'TX-987654' }),
      ]);

      const result = await finder.findLinks(undefined, undefined, { detectors: ['reference'] });

      expect(result).toHaveLength(0);
    });

    it('should ignore placeholder references', async () => {
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        withdrawal('1', '2024-03-01', '59.00', 'Telekom', { sepa_ct_id: 'NOTPROVIDED' }),
        deposit('2', '2024-03-08', '59.00', 'Telekom', { sepa_ct_id: 'NOTPROVIDED' }),
      ]);

      const result = await finder.findLinks(undefined, undefined, { detectors: ['reference'] });

      expect(result).toHaveLength(0);
    });

    it('should use journal IDs for split transactions', async () => {
      const group: FireflyTransaction = {
        ...withdrawal('10', '2024-03-01', '80.00', 'Amazon'),
      };
      group.attributes.transactions = [
        createSplit({
          transaction_journal_id: '11',
          amount: '30.00',
          destination_name: 'Amazon',
          description: 'Order 302-1111111-2222222',
        }),
        createSplit({ transaction_journal_id: '12', amount: '50.00', destination_name: 'Amazon' }),
      ];
      mockFireflyApi.getAllTransactions.mockResolvedValue([
        group,
        deposit('20', '2024-03-05', '30.00', 'Amazon', {
          description: 'Erstattung 302-1111111-2222222',
        }),
      ]);

      const result = await finder.findLinks();

      expect(result).toHaveLength(1);
      expect(result[0].inward.transactionId).toBe('10');
      expect(result[0].inward.journalId).toBe('11');
    });
  });

  describe('createLinks', () => {
    it('should resolve link type names and report failures', async () => {
      mockFireflyApi.getAllLinkTypes.mockResolvedValue([
        {
          id: '4',
          type: 'link_types',
          attributes: {
            name: 'Refund',
            inward: 'is refunded by',
            outward: 'refunds',
            editable: false,
          },
        },
      ]);

      const result = await finder.createLinks([
        { inwardId: '1', outwardId: '2', linkTypeName: 'refund' },
        { inwardId: '3', outwardId: '4', linkTypeName: 'Unknown' },
      ]);

      expect(mockFireflyApi.createTransactionLink).toHaveBeenCalledWith({
        linkTypeId: '4',
        inwardId: '1',
        outwardId: '2',
        notes: undefined,
      });
      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
    });
  });
});

describe('calculateNameSimilarity', () => {
  it('should ignore legal forms and filler words', () => {
    expect(calculateNameSimilarity('amazon eu s.a.r.l.', 'amazon payments europe')).toBe(1);
  });

  it('should match names sharing all significant tokens of the shorter name', () => {
    expect(calculateNameSimilarity('amazon eu s.a.r.l.', 'amazon marketplace')).toBe(0.9);
  });

  it('should not match unrelated names', () => {
    expect(calculateNameSimilarity('rewe markt gmbh', 'edeka')).toBeLessThan(0.5);
  });
});

describe('extractReferences', () => {
  it('should extract structured and free-text references', () => {
    const refs = extractReferences(
      createSplit({
        sepa_ct_id: 'e2e-123456',
        external_id: 'NOTPROVIDED',
        description: 'PayPal 1AB23456CD789012E Rechnung Nr. RE-2024-0815',
        notes: 'Amazon order 028-1234567-7654321',
      })
    );

    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: 'structured', value: 'E2E-123456' },
        { kind: 'amazon', value: '028-1234567-7654321' },
        { kind: 'paypal', value: '1AB23456CD789012E' },
        { kind: 'invoice', value: 'RE-2024-0815' },
      ])
    );
    expect(refs).toHaveLength(4);
  });
});
