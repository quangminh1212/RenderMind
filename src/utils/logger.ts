export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  private format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${LEVEL_LABELS[level]}] ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      return `${base} ${JSON.stringify(meta)}`;
    }
    return base;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(this.format(LogLevel.DEBUG, message, meta));
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      console.info(this.format(LogLevel.INFO, message, meta));
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.format(LogLevel.WARN, message, meta));
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(this.format(LogLevel.ERROR, message, meta));
    }
  }
}

function parseLogLevel(env?: string): LogLevel {
  switch (env?.toLowerCase()) {
    case 'debug':
      return LogLevel.DEBUG;
    case 'warn':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

export const logger = new Logger(parseLogLevel(process.env.LOG_LEVEL));
