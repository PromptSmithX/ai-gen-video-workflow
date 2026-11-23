import fs from 'node:fs';
import path from 'node:path';
import type { ImageInfo } from '@shared/domain';
import { normalizeSku } from '@shared/domain';
import { PodError } from '@shared/errors';
import type { MediaLibrary, StoredFile } from '@shared/services';
import { newId } from '../../domain/ids';
import { hashBuffer, hashFile } from './hash';
import { validateImageHeader } from './image';
import { getSkuDir, resolveSafe } from './sku-path';
import { validateMp4Video } from './video';

export interface CreateMediaLibraryOpts {
  root: string;
  tempDir: string;
  maxSourceBytes: number;
  maxSourcePixels: number;
  maxVideoBytes: number;
}

/**
 * Removes `.part` files in `tempDir` that have not been modified for `olderThanMs`.
 * Returns the count of removed files.
 */
export function cleanupTemp(tempDir: string, olderThanMs: number): number {
  if (!fs.existsSync(tempDir)) {
    return 0;
  }

  const now = Date.now();
  let count = 0;
  const files = fs.readdirSync(tempDir);

  for (const f of files) {
    if (!f.endsWith('.part')) {
      continue;
    }
    const fullPath = path.join(tempDir, f);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs >= olderThanMs) {
        fs.unlinkSync(fullPath);
        count++;
      }
    } catch {
      // Ignore files that disappeared or cannot be unlinked
    }
  }

  return count;
}

export class DefaultMediaLibrary implements MediaLibrary {
  readonly root: string;
  private readonly tempDir: string;
  private readonly maxSourceBytes: number;
  private readonly maxSourcePixels: number;
  private readonly maxVideoBytes: number;

  constructor(opts: CreateMediaLibraryOpts) {
    this.root = path.resolve(opts.root);
    this.tempDir = path.resolve(opts.tempDir);
    this.maxSourceBytes = opts.maxSourceBytes;
    this.maxSourcePixels = opts.maxSourcePixels;
    this.maxVideoBytes = opts.maxVideoBytes;

    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  async validateImage(absPath: string): Promise<ImageInfo> {
    return validateImageHeader(absPath, this.maxSourceBytes, this.maxSourcePixels);
  }

  async importSourceImage(absPath: string, sku: string): Promise<StoredFile> {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) {
      throw new PodError('INVALID_SKU', `Invalid SKU format: ${String(sku)}`);
    }

    const info = await this.validateImage(absPath);
    const skuRoot = this.skuDir(normalizedSku);
    const sourceDir = path.join(skuRoot, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });

    const ext = info.mime === 'image/jpeg' ? 'jpg' : info.mime === 'image/webp' ? 'webp' : 'png';

    // First candidate: <SKU>-original.<ext>
    let filename = `${normalizedSku}-original.${ext}`;
    let targetAbs = path.join(sourceDir, filename);

    if (fs.existsSync(targetAbs)) {
      let counter = 2;
      while (fs.existsSync(targetAbs)) {
        filename = `${normalizedSku}-original-${counter}.${ext}`;
        targetAbs = path.join(sourceDir, filename);
        counter++;
      }
    }

    // Byte-identical copy
    fs.copyFileSync(absPath, targetAbs);

    const sha256 = await hashFile(targetAbs);
    const relPath = path.relative(this.root, targetAbs).replace(/\\/g, '/');

    return {
      relPath,
      absPath: targetAbs,
      mime: info.mime,
      bytes: info.bytes,
      sha256,
      width: info.width,
      height: info.height,
    };
  }

  writePromptSnapshot(sku: string, label: string, text: string): Promise<StoredFile> {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) {
      throw new PodError('INVALID_SKU', `Invalid SKU format: ${String(sku)}`);
    }

    const skuRoot = this.skuDir(normalizedSku);
    const promptsDir = path.join(skuRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });

    // Sanitize label
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${normalizedSku}-prompt-${safeLabel}.md`;
    const targetAbs = path.join(promptsDir, filename);

    const buf = Buffer.from(text, 'utf8');
    fs.writeFileSync(targetAbs, buf);

    const relPath = path.relative(this.root, targetAbs).replace(/\\/g, '/');
    const sha256 = hashBuffer(buf);

    return Promise.resolve({
      relPath,
      absPath: targetAbs,
      mime: 'text/markdown',
      bytes: buf.length,
      sha256,
      width: null,
      height: null,
    });
  }

  newTempPath(): string {
    fs.mkdirSync(this.tempDir, { recursive: true });
    return path.join(this.tempDir, `${newId()}.part`);
  }

  async storeVideo(tempPartPath: string, sku: string): Promise<StoredFile> {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) {
      try {
        fs.unlinkSync(tempPartPath);
      } catch {
        // ignore
      }
      throw new PodError('DOWNLOAD_FAILED', 'Invalid SKU for storeVideo');
    }

    // Validate video container & size
    try {
      await validateMp4Video(tempPartPath, this.maxVideoBytes);
    } catch (err) {
      try {
        fs.unlinkSync(tempPartPath);
      } catch {
        // ignore
      }
      if (err instanceof PodError) {
        throw err;
      }
      throw new PodError('DOWNLOAD_FAILED', 'Failed to validate video file', { cause: err });
    }

    const sha256 = await hashFile(tempPartPath);
    const stat = fs.statSync(tempPartPath);

    const skuRoot = this.skuDir(normalizedSku);
    const videosDir = path.join(skuRoot, 'videos');
    fs.mkdirSync(videosDir, { recursive: true });

    // Pick next <SKU>-video-NNN.mp4
    let maxNum = 0;
    const regex = new RegExp(`^${normalizedSku}-video-(\\d{3})\\.mp4$`, 'i');

    try {
      const files = fs.readdirSync(videosDir);
      for (const f of files) {
        const m = f.match(regex);
        if (m && m[1]) {
          const num = parseInt(m[1], 10);
          if (num > maxNum) {
            maxNum = num;
          }
        }
      }
    } catch {
      // ignore
    }

    const nextNum = maxNum + 1;
    const filename = `${normalizedSku}-video-${String(nextNum).padStart(3, '0')}.mp4`;
    const targetAbs = path.join(videosDir, filename);

    // Atomic move via rename, or copy+fsync+rename when cross-volume (EXDEV)
    try {
      fs.renameSync(tempPartPath, targetAbs);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'EXDEV') {
        try {
          fs.copyFileSync(tempPartPath, targetAbs);
          const fd = fs.openSync(targetAbs, 'r+');
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.unlinkSync(tempPartPath);
        } catch (copyErr) {
          try {
            fs.unlinkSync(tempPartPath);
          } catch {
            // ignore
          }
          try {
            if (fs.existsSync(targetAbs)) fs.unlinkSync(targetAbs);
          } catch {
            // ignore
          }
          throw new PodError('DOWNLOAD_FAILED', 'Failed to store video across devices', { cause: copyErr });
        }
      } else {
        try {
          fs.unlinkSync(tempPartPath);
        } catch {
          // ignore
        }
        throw new PodError('DOWNLOAD_FAILED', 'Failed to store video', { cause: err });
      }
    }

    const relPath = path.relative(this.root, targetAbs).replace(/\\/g, '/');

    return {
      relPath,
      absPath: targetAbs,
      mime: 'video/mp4',
      bytes: stat.size,
      sha256,
      width: null,
      height: null,
    };
  }

  writeMetadata(sku: string, baseName: string, data: Record<string, unknown>): Promise<StoredFile> {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) {
      throw new PodError('INVALID_SKU', `Invalid SKU format: ${String(sku)}`);
    }

    const skuRoot = this.skuDir(normalizedSku);
    const metadataDir = path.join(skuRoot, 'metadata');
    fs.mkdirSync(metadataDir, { recursive: true });

    const cleanBase = baseName.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${cleanBase}.json`;
    const targetAbs = path.join(metadataDir, filename);

    const jsonText = JSON.stringify(data, null, 2) + '\n';
    const buf = Buffer.from(jsonText, 'utf8');
    fs.writeFileSync(targetAbs, buf);

    const relPath = path.relative(this.root, targetAbs).replace(/\\/g, '/');
    const sha256 = hashBuffer(buf);

    return Promise.resolve({
      relPath,
      absPath: targetAbs,
      mime: 'application/json',
      bytes: buf.length,
      sha256,
      width: null,
      height: null,
    });
  }

  resolve(relPath: string): string {
    return resolveSafe(this.root, relPath);
  }

  skuDir(sku: string): string {
    return getSkuDir(this.root, sku);
  }

  cleanupTemp(olderThanMs: number): number {
    return cleanupTemp(this.tempDir, olderThanMs);
  }
}

/**
 * Creates and returns a MediaLibrary instance.
 */
export function createMediaLibrary(opts: CreateMediaLibraryOpts): MediaLibrary {
  return new DefaultMediaLibrary(opts);
}
