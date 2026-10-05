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
  429: 'rate_limited',
};

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
    } else {
      this.logger.error({ err: exception }, 'unhandled exception');
    }
    res.status(status).json(body);
  }
}
