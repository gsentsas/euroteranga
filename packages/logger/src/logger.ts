import { redact, redactString } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names owned by the logger; caller fields cannot overwrite them. */
const RESERVED_FIELDS = new Set(['timestamp', 'level', 'service', 'message', 'request_id']);

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Returns ambient context, typically the current request id. */
  context?: () => { requestId?: string | undefined } | undefined;
  /** Output sink, one JSON document per call. Defaults to stdout. */
  write?: (line: string) => void;
  /** Static fields added to every entry. */
  bindings?: LogFields;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

const defaultWrite = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_WEIGHT[options.level ?? 'info'];
  const write = options.write ?? defaultWrite;

  const isLevelEnabled = (level: LogLevel): boolean => LEVEL_WEIGHT[level] >= minimum;

  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!isLevelEnabled(level)) return;

    const extra = redact({ ...options.bindings, ...fields }, { includeStack: true }) as LogFields;
    for (const key of RESERVED_FIELDS) delete extra[key];

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: options.service,
      message: redactString(message),
      request_id: options.context?.()?.requestId ?? null,
      ...extra,
    };
    write(JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    isLevelEnabled,
    child: (bindings) =>
      createLogger({ ...options, bindings: { ...options.bindings, ...bindings } }),
  };
}
