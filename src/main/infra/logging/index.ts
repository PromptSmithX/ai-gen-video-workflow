import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { LogFields, Logger } from '@shared/services';
import { redactFields, redactText } from './redact';

export { redactFields, redactText };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface CreateLoggerOpts {
  dir: string;
  retentionDays: number;
  level?: LogLevel;
}

/**
 * Creates a structured JSON lines logger writing to <dir>/pod-YYYY-MM-DD.log.
 * Automatically redacts sensitive fields and string patterns.
 * Supports child loggers and asynchronous log flushing.
 */
export function createLogger(opts: CreateLoggerOpts): Logger & { flush(): Promise<void> } {
  const { dir, level = 'info' } = opts;
  const minPriority = LOG_LEVEL_PRIORITY[level];

  let writeQueue = Promise.resolve();

  function writeLog(logLevel: LogLevel, event: string, fields?: LogFields): void {
    if (LOG_LEVEL_PRIORITY[logLevel] < minPriority) {
      return;
    }

    const ts = new Date().toISOString();
    const dateStr = ts.slice(0, 10);
    const logFilePath = join(dir, `pod-${dateStr}.log`);

    const cleanedFields = fields ? redactFields(fields as Record<string, unknown>) : {};
    const logEntry = {
      ts,
      level: logLevel,
      event,
      ...cleanedFields,
    };

    const line = JSON.stringify(logEntry) + '\n';

    writeQueue = writeQueue.then(async () => {
      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        await fs.appendFile(logFilePath, line, 'utf-8');
      } catch {
        // Silently swallow log write failures to avoid bringing down the app
      }
    });
  }

  function makeLogger(inheritedFields: LogFields = {}): Logger {
    return {
      debug(event: string, fields?: LogFields): void {
        writeLog('debug', event, { ...inheritedFields, ...fields });
      },
      info(event: string, fields?: LogFields): void {
        writeLog('info', event, { ...inheritedFields, ...fields });
      },
      warn(event: string, fields?: LogFields): void {
        writeLog('warn', event, { ...inheritedFields, ...fields });
      },
      error(event: string, fields?: LogFields): void {
        writeLog('error', event, { ...inheritedFields, ...fields });
      },
      child(fields: LogFields): Logger {
        return makeLogger({ ...inheritedFields, ...fields });
      },
    };
  }

  const rootLogger = makeLogger();

  return {
    ...rootLogger,
    flush(): Promise<void> {
      return writeQueue;
    },
  };
}

/**
 * Deletes log files matching pod-YYYY-MM-DD.log older than retentionDays.
 * Returns the count of deleted files.
 */
export function cleanupLogs(dir: string, retentionDays: number): number {
  if (!existsSync(dir)) {
    return 0;
  }

  let deletedCount = 0;
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const fileRegex = /^pod-(\d{4}-\d{2}-\d{2})\.log$/;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const match = fileRegex.exec(entry);
    if (!match) continue;

    const dateStr = match[1];
    if (!dateStr) continue;

    const fileDate = new Date(`${dateStr}T00:00:00Z`).getTime();
    if (isNaN(fileDate)) continue;

    if (now - fileDate > maxAgeMs) {
      try {
        unlinkSync(join(dir, entry));
        deletedCount++;
      } catch {
        // Ignore deletion errors
      }
    }
  }

  return deletedCount;
}
