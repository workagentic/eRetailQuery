import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { ErrorResponse } from '@erq/shared';
import { LOGGER } from '../config/config.module';
import { ApiError } from './api-error';

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
};

/** Errors thrown by Express' body parser (too large, malformed JSON) carry a 4xx status and a type like 'entity.too.large'. */
function isBodyParserError(e: unknown): e is { status: number; type: string } {
  if (typeof e !== 'object' || e === null) return false;
  const { status, type } = e as { status?: unknown; type?: unknown };
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    typeof type === 'string' &&
    type.startsWith('entity.')
  );
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let body: ErrorResponse = {
      error: { code: 'internal_error', message: 'Internal server error' },
    };

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      body = {
        error: { code: exception.code, message: exception.message, details: exception.details },
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { error: { code: STATUS_CODES[status] ?? 'error', message: exception.message } };
    } else if (isBodyParserError(exception)) {
      status = exception.status;
      body = {
        error: { code: STATUS_CODES[status] ?? 'bad_request', message: 'Invalid request body' },
      };
    } else {
      this.logger.error({ err: exception }, 'unhandled exception');
    }
    res.status(status).json(body);
  }
}
