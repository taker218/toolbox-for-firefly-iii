import { Router, Request, Response } from 'express';
import { getFireflyApi } from '../clients/firefly.js';
import { LinkFinder } from '../services/linkFinder.js';
import { isFireflyConfigured } from '../config/index.js';
import {
  getPersistedSessionId,
  asyncHandler,
  badRequest,
  setupSSE,
  bulkOperationRateLimit,
} from '../middleware/index.js';
import { createLogger } from '../utils/logger.js';
import {
  getCacheKey,
  getCachedTransactions,
  setCachedTransactions,
} from '../services/transactionCache.js';
import {
  validateBody,
  linkFindSchema,
  bulkLinkSchema,
  countTransactionsSchema,
  type LinkFindBody,
  type BulkLinkBody,
  type CountTransactionsBody,
} from '../utils/index.js';

const logger = createLogger('Links');

const router = Router();

// Middleware to check Firefly III configuration
router.use((_req: Request, _res: Response, next) => {
  if (!isFireflyConfigured()) {
    throw badRequest(
      'Firefly III is not configured. Please set FIREFLY_API_URL and FIREFLY_API_TOKEN.'
    );
  }
  next();
});

// Stream link finding (SSE)
router.post('/stream-find', validateBody(linkFindSchema), async (req: Request, res: Response) => {
  const { startDate, endDate, options } = req.body as LinkFindBody;
  const sessionId = getPersistedSessionId(req);
  const cacheKey = getCacheKey(startDate, endDate);

  logger.debug('Stream find links started', { startDate, endDate, options });

  const sse = setupSSE(res, req);
  const finder = new LinkFinder(getFireflyApi());
  const cachedTransactions = getCachedTransactions(sessionId, cacheKey);

  try {
    for await (const event of finder.streamFindLinks(
      startDate,
      endDate,
      options,
      cachedTransactions || undefined
    )) {
      // Stop processing if client disconnected
      if (!sse.isConnected()) {
        logger.debug('Client disconnected during stream');
        break;
      }
      sse.send(event.type, event.data);
    }
    sse.end();
  } catch (error) {
    logger.error('Error streaming link results', error);
    sse.error(error instanceof Error ? error : 'Unknown error');
  }
});

// Available Firefly III link types
router.get(
  '/link-types',
  asyncHandler(async (_req: Request, res: Response) => {
    const finder = new LinkFinder(getFireflyApi());
    const linkTypes = await finder.getLinkTypes();
    res.json({ success: true, data: linkTypes });
  })
);

// Create links in bulk
// Rate limited to prevent accidental mass linking
router.post(
  '/create-bulk',
  bulkOperationRateLimit,
  validateBody(bulkLinkSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { links } = req.body as BulkLinkBody;

    logger.info(`Creating ${links.length} transaction links`);

    const finder = new LinkFinder(getFireflyApi());
    const results = await finder.createLinks(links);

    res.json({
      success: true,
      data: results,
      message: `Created ${results.successful.length} links, ${results.failed.length} failed`,
    });
  })
);

// Count transactions for wizard step 1
router.post(
  '/count-transactions',
  validateBody(countTransactionsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { startDate, endDate, limit, offset, refresh } = req.body as CountTransactionsBody;
    const sessionId = getPersistedSessionId(req);
    const cacheKey = getCacheKey(startDate, endDate);

    let transactions = refresh ? null : getCachedTransactions(sessionId, cacheKey);
    if (!transactions) {
      transactions = await getFireflyApi().getAllTransactions(startDate, endDate);
      // Cache for later use in stream-find
      setCachedTransactions(sessionId, cacheKey, transactions);
    }

    const previewLimit = limit || 10;
    const previewOffset = offset || 0;
    const preview = transactions
      .slice(previewOffset, previewOffset + previewLimit)
      .map((t) => t.attributes.transactions[0]);

    res.json({
      success: true,
      data: { count: transactions.length, transactions: preview },
    });
  })
);

export default router;
