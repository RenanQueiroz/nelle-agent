export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** A minimal console logger with pino's `(mergingObject, message)` call shape. */
export function createLogger(): Logger {
  const write = (level: 'info' | 'warn' | 'error', obj: unknown, msg?: string): void => {
    const message = typeof obj === 'string' ? obj : msg;
    const detail = typeof obj === 'string' ? undefined : obj;
    const line = `[nelle] ${level}: ${message ?? ''}`.trimEnd();
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (detail === undefined) {
      sink(line);
    } else {
      sink(line, detail);
    }
  };
  return {
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
  };
}
