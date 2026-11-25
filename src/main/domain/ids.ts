import { randomUUID } from 'node:crypto';

/**
 * Generates a new UUID v4.
 */
export function newId(): string {
  return randomUUID();
}

/**
 * Returns current timestamp as ISO-8601 string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
