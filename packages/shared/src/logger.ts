import pino from 'pino';

const SECRET_KEYS = [
  'token',
  'password',
  'authorization',
  'cookie',
  'access_token',
  'refresh_token',
  'encrypted_credentials',
  'credentials',
  'secret',
  'apiKey',
  'api_key',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'apiSecret',
  'encryptedCredentials',
];

export const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
];

export interface LoggerOptions {
  level?: string;
  destination?: { write(chunk: string): void };
}

export function createLogger(opts: LoggerOptions = {}): pino.Logger {
  return pino(
    { level: opts.level ?? 'info', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    opts.destination,
  );
}
