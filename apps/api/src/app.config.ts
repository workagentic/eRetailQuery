import type { INestApplication } from '@nestjs/common';
import { json, type ErrorRequestHandler, type Request } from 'express';

/**
 * Create the Nest app with these options (main.ts and the test helper both use them):
 * Nest's default body parsers are off so configureApp controls the limits, and the raw bytes
 * are captured by our own parsers for webhook HMAC verification.
 */
export const APP_CREATE_OPTIONS = { rawBody: true, bodyParser: false } as const;

export const DEFAULT_JSON_LIMIT = '100kb';
/** Shopify webhook payloads can reach about 1MB. */
export const WEBHOOK_JSON_LIMIT = '2mb';
export const WEBHOOK_PATH = '/webhooks/shopify';

type RawBodyRequest = Request & { rawBody?: Buffer };
const captureRawBody = (req: unknown, _res: unknown, buf: Buffer): void => {
  (req as RawBodyRequest).rawBody = buf;
};

/**
 * Nest rewraps a body-parser SyntaxError as BadRequestException(err.message), and that message quotes
 * a fragment of the caller's body. Answer parse failures here with a fixed body instead, in the
 * same shape ApiExceptionFilter produces. Other parser errors (too large) fall through to the filter.
 */
const fixedParseError: ErrorRequestHandler = (err, _req, res, next) => {
  if ((err as { type?: unknown } | null)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Invalid request body' } });
    return;
  }
  next(err);
};

/** Shared app-level configuration. Call before app.init(). The webhook parser is mounted first and marks the body as parsed, so the global parser skips that route. */
export function configureApp(app: INestApplication): void {
  app.use(WEBHOOK_PATH, json({ limit: WEBHOOK_JSON_LIMIT, verify: captureRawBody }));
  app.use(WEBHOOK_PATH, fixedParseError);
  app.use(json({ limit: DEFAULT_JSON_LIMIT, verify: captureRawBody }));
  app.use(fixedParseError);
}
