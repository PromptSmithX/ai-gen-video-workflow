import path from 'node:path';
import type { ImageInfo } from '@shared/domain';
import { MEDIA_PROTOCOL, type StagedImage } from '@shared/ipc';
import { newId } from '../domain/ids';

export interface StagedImageRecord {
  token: string;
  absPath: string;
  fileName: string;
  info: ImageInfo;
  expiresAt: number;
}

export class ImageStagingService {
  private readonly staged = new Map<string, StagedImageRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3600_000) {
    this.ttlMs = ttlMs;
  }

  stage(absPath: string, info: ImageInfo): StagedImage {
    this.cleanupExpired();
    const token = newId();
    const fileName = path.basename(absPath);
    const record: StagedImageRecord = {
      token,
      absPath,
      fileName,
      info,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.staged.set(token, record);

    return {
      token,
      fileName,
      info,
      previewUrl: `${MEDIA_PROTOCOL}://staged/${token}`,
    };
  }

  get(token: string): StagedImageRecord | null {
    const record = this.staged.get(token);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      this.staged.delete(token);
      return null;
    }
    return record;
  }

  delete(token: string): void {
    this.staged.delete(token);
  }

  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [token, record] of this.staged.entries()) {
      if (now > record.expiresAt) {
        this.staged.delete(token);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.staged.clear();
  }
}
