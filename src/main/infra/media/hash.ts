import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Computes SHA-256 hash of a file as a streaming operation.
 */
export async function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(absPath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Computes SHA-256 hash of a buffer.
 */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
