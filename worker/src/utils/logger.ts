/* eslint-disable no-console -- this module is the single place allowed to write logs */
/**
 * Structured JSON logging.
 *
 * Workers `wrangler tail` and Cloudflare Logpush both render JSON lines well, so
 * every log entry is a single line object with a stable shape. Logs must never
 * contain secrets: callers pass identifiers, never credentials.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(base: Record<string, unknown> = {}, minLevel: LogLevel = 'info'): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
    const entry: Record<string, unknown> = { level, message, time: new Date().toISOString(), ...base };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        entry[key] = value instanceof Error ? serialiseError(value) : value;
      }
    }
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }, minLevel),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
