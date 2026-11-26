import fs from 'node:fs';
import path from 'node:path';
import { PodError } from '@shared/errors';

/**
 * Re-encodes an image to JPEG, optionally downscaling so the long edge is at most `maxLongEdge`
 * (never upscales). Transparent pixels must be flattened onto white.
 */
export interface UploadImageEncoder {
  encodeJpeg(
    srcPath: string,
    opts: { maxLongEdge: number | null; quality: number }
  ): Promise<{ data: Buffer; width: number; height: number }>;
  /** Drops any decoded image the encoder cached between ladder steps. */
  release?(): void;
}

export interface PreparedUploadImage {
  /** Path to hand to the provider: the original file, or a temp JPEG. */
  path: string;
  fileName: string;
  transcoded: boolean;
  originalBytes: number;
  uploadBytes: number;
  width: number | null;
  height: number | null;
  quality: number | null;
  /** Removes the temp JPEG (no-op when the original is used). Never throws. */
  cleanup(): void;
}

/**
 * Quality ladder, best first. Full resolution is tried before any downscale; Muse renders at most
 * 1080p video, so even a 2048 px long edge carries more detail than the output can show.
 */
export const UPLOAD_LADDER: ReadonlyArray<{ maxLongEdge: number | null; quality: number }> = [
  { maxLongEdge: null, quality: 95 },
  { maxLongEdge: null, quality: 92 },
  { maxLongEdge: null, quality: 90 },
  { maxLongEdge: 6000, quality: 92 },
  { maxLongEdge: 5000, quality: 92 },
  { maxLongEdge: 4096, quality: 92 },
  { maxLongEdge: 3072, quality: 90 },
  { maxLongEdge: 2560, quality: 90 },
  { maxLongEdge: 2048, quality: 90 },
  { maxLongEdge: 2048, quality: 85 },
];

/** Headroom kept below the provider limit (multipart overhead, rounding). */
const TARGET_RATIO = 0.95;

/**
 * Returns an upload-ready image for the provider. Files within `maxBytes` are passed through untouched;
 * larger ones are re-encoded to a temp JPEG using the highest-quality ladder step that fits.
 * The library's original file is never modified.
 */
export async function prepareUploadImage(opts: {
  srcPath: string;
  fileName: string;
  maxBytes: number;
  newTempPath: () => string;
  encoder: UploadImageEncoder | null | undefined;
}): Promise<PreparedUploadImage> {
  const originalBytes = fs.statSync(opts.srcPath).size;
  if (originalBytes <= opts.maxBytes || !opts.encoder) {
    return {
      path: opts.srcPath,
      fileName: opts.fileName,
      transcoded: false,
      originalBytes,
      uploadBytes: originalBytes,
      width: null,
      height: null,
      quality: null,
      cleanup: () => {},
    };
  }

  try {
    return await transcodeForUpload({ ...opts, encoder: opts.encoder }, originalBytes);
  } finally {
    opts.encoder.release?.();
  }
}

async function transcodeForUpload(
  opts: { srcPath: string; fileName: string; maxBytes: number; newTempPath: () => string; encoder: UploadImageEncoder },
  originalBytes: number
): Promise<PreparedUploadImage> {
  const target = Math.floor(opts.maxBytes * TARGET_RATIO);
  let originalLongEdge: number | null = null;

  for (const step of UPLOAD_LADDER) {
    // A downscale step that would not shrink the image is identical to a full-size step: skip it.
    if (step.maxLongEdge !== null && originalLongEdge !== null && step.maxLongEdge >= originalLongEdge) {
      continue;
    }
    let encoded: { data: Buffer; width: number; height: number };
    try {
      encoded = await opts.encoder.encodeJpeg(opts.srcPath, step);
    } catch (err) {
      throw new PodError('INVALID_IMAGE', 'Source image could not be re-encoded for upload', { cause: err });
    }
    if (step.maxLongEdge === null) {
      originalLongEdge = Math.max(encoded.width, encoded.height);
    }
    if (encoded.data.length > target) continue;

    const tempPath = opts.newTempPath();
    fs.writeFileSync(tempPath, encoded.data);
    const base = path.basename(opts.fileName, path.extname(opts.fileName)) || 'source';
    return {
      path: tempPath,
      fileName: `${base}.jpg`,
      transcoded: true,
      originalBytes,
      uploadBytes: encoded.data.length,
      width: encoded.width,
      height: encoded.height,
      quality: step.quality,
      cleanup: () => {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // best effort
        }
      },
    };
  }

  throw new PodError('IMAGE_TOO_LARGE', 'Source image is too large to upload even after compression');
}
