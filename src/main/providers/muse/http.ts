/**
 * Safe HTTP helpers for the Muse provider.
 * Enforces loopback-only networking, redirect rejection, streaming size caps,
 * and strict error handling without secret leakage.
 */
import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ProviderError } from '@shared/provider';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validates that a bridge base URL is loopback-only and uses http/https.
 * Throws ProviderError with code UNSUPPORTED_PLATFORM or NOT_CONNECTED.
 */
export function validateLoopbackUrl(urlStr: string | null | undefined): URL {
  if (!urlStr || typeof urlStr !== 'string' || urlStr.trim() === '') {
    throw new ProviderError('NOT_CONNECTED', 'before_submit', 'Bridge base URL is not configured.');
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new ProviderError('UNSUPPORTED_PLATFORM', 'before_submit', 'Invalid bridge URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError(
      'UNSUPPORTED_PLATFORM',
      'before_submit',
      'Bridge URL must use HTTP or HTTPS.'
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new ProviderError(
      'UNSUPPORTED_PLATFORM',
      'before_submit',
      'Non-loopback bridge URLs are strictly forbidden for security reasons.'
    );
  }

  return parsed;
}

/**
 * Validates that an asset download URL strictly matches the expected bridge origin.
 */
export function validateSameOrigin(targetUrlStr: string, expectedOrigin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(targetUrlStr);
  } catch {
    throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Invalid asset download URL format.');
  }

  if (parsed.origin.toLowerCase() !== expectedOrigin.toLowerCase()) {
    throw new ProviderError(
      'DOWNLOAD_FAILED',
      'after_submit',
      'Asset download URL origin does not match the approved bridge origin.'
    );
  }

  return parsed;
}

export interface StreamDownloadOptions {
  url: string;
  destPath: string;
  maxBytes: number;
  apiKey?: string | null;
  timeoutMs?: number;
}

/**
 * Downloads a remote asset stream to destPath with a strict maximum byte cap.
 * Deletes the destination file if download exceeds maxBytes or fails.
 */
export async function streamDownloadToFile(options: StreamDownloadOptions): Promise<number> {
  const { url, destPath, maxBytes, apiKey, timeoutMs = 60_000 } = options;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    safeUnlink(destPath);
    throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Failed to connect to download URL.', {
      cause: err,
    });
  }

  clearTimeout(timeoutId);

  // Manual redirect detection
  if (response.status >= 300 && response.status < 400) {
    safeUnlink(destPath);
    throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Redirects are not permitted during asset download.');
  }

  if (!response.ok) {
    safeUnlink(destPath);
    throw new ProviderError(
      'DOWNLOAD_FAILED',
      'after_submit',
      `Asset download failed with status ${response.status}.`
    );
  }

  if (!response.body) {
    safeUnlink(destPath);
    throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Asset response has no body.');
  }

  // Check Content-Length header upfront if available
  const contentLengthHeader = response.headers.get('content-length');
  const expectedContentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  if (expectedContentLength !== null && !isNaN(expectedContentLength) && expectedContentLength > maxBytes) {
    safeUnlink(destPath);
    throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Asset size exceeds maximum allowed bytes.');
  }

  let bytesWritten = 0;
  const outStream = fs.createWriteStream(destPath);

  try {
    // Convert Web ReadableStream to Node Readable
    const nodeReadable = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>);

    nodeReadable.on('data', (chunk: Buffer | Uint8Array) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        nodeReadable.destroy(new Error('MAX_BYTES_EXCEEDED'));
      }
    });

    await pipeline(nodeReadable, outStream);

    // Verify truncated download if content-length was declared
    if (expectedContentLength !== null && !isNaN(expectedContentLength) && bytesWritten !== expectedContentLength) {
      throw new Error('TRUNCATED_STREAM');
    }

    return bytesWritten;
  } catch (err) {
    outStream.close();
    safeUnlink(destPath);
    throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Download failed, was truncated, or exceeded size limit.', {
      cause: err,
    });
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup
  }
}
