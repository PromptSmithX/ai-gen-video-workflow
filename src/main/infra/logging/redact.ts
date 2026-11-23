import os from 'node:os';

/**
 * Regex matching sensitive keys that should be replaced with "[REDACTED]".
 * Covers prompt text, tokens, API keys, authorization headers, cookies,
 * sessions, secrets, passwords, and signatures.
 */
export const SENSITIVE_KEY_PATTERN =
  /prompt|token|api[-_]?key|authorization|cookie|session|secret|password|signature|signed/i;

/**
 * Redacts sensitive substrings inside arbitrary text:
 * - Bearer tokens: Bearer <token> -> Bearer [REDACTED]
 * - sk-... style tokens (>=16 chars) -> [REDACTED]
 * - Long hex tokens (>=24 chars) -> [REDACTED]
 * - URL query strings: https://...?secret=123 -> https://...?[REDACTED]
 * - Absolute Windows paths (C:\... or \\server\...) -> [PATH]
 * - User home directory -> [PATH]
 * - Cookies in text (Cookie: ... or cookie=...) -> cookie=[REDACTED]
 */
export function redactText(text: string): string {
  if (!text) return text;

  let result = text;

  // 1. Redact Authorization Bearer headers
  result = result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');

  // 2. Redact sk-... tokens
  result = result.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/gi, '[REDACTED]');

  // 3. Redact long hex tokens (>= 24 continuous hex characters)
  result = result.replace(/\b[a-fA-F0-9]{24,}\b/g, '[REDACTED]');

  // 4. Redact URL query strings (e.g. signed URLs, token params)
  result = result.replace(/(https?:\/\/[^\s/?#]+[^\s?#]*)\?[^\s#]*/gi, '$1?[REDACTED]');

  // 5. Redact Cookies in text
  result = result.replace(/(?:^|\b)(?:Cookie:\s*|cookie=)[^\r\n;,\s]+/gi, 'cookie=[REDACTED]');

  // 6. Redact User Home Directory (if available)
  try {
    const home = os.homedir();
    if (home && home.length > 3) {
      const escapedHomeBackslash = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedHomeForward = home.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escapedHomeBackslash, 'gi'), '[PATH]');
      result = result.replace(new RegExp(escapedHomeForward, 'gi'), '[PATH]');
    }
  } catch {
    // Ignore error reading homedir
  }

  // 7. Redact Absolute Windows paths (C:\... or C:/... or \\server\...)
  // Notice: drive letter must have exactly one letter preceded by non-alphanumeric to avoid matching protocols like https://
  result = result.replace(/(?<![a-zA-Z0-9])[a-zA-Z]:[\\/][^\s"',;`<>|]+/g, '[PATH]');
  result = result.replace(/(?<![a-zA-Z0-9])\\\\[^\s"',;`<>|]+/g, '[PATH]');

  return result;
}

/**
 * Recursively applies redaction to fields of a log record or object.
 * Replaces keys matching SENSITIVE_KEY_PATTERN with "[REDACTED]",
 * and applies redactText to string values.
 */
export function redactFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      result[key] = redactText(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'string') {
          return redactText(item);
        }
        if (typeof item === 'object' && item !== null) {
          return redactFields(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}
