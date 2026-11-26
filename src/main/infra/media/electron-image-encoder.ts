import { nativeImage, type NativeImage } from 'electron';
import type { UploadImageEncoder } from './upload-image';
import type { ReferenceBoardRenderer } from './reference-board';

/**
 * Composites premultiplied BGRA pixels onto white in place. Returns false when the image is fully opaque
 * (nothing changed). Chromium bitmaps are premultiplied, so white-composite is `c + (255 - a)`.
 */
export function flattenPremultipliedOntoWhite(bgra: Buffer): boolean {
  let changed = false;
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3]!;
    if (a === 255) continue;
    const inv = 255 - a;
    bgra[i] = Math.min(255, bgra[i]! + inv);
    bgra[i + 1] = Math.min(255, bgra[i + 1]! + inv);
    bgra[i + 2] = Math.min(255, bgra[i + 2]! + inv);
    bgra[i + 3] = 255;
    changed = true;
  }
  return changed;
}

/** Upload encoder backed by Electron's nativeImage (Skia). No extra dependency, main process only. */
export function createElectronImageEncoder(): UploadImageEncoder {
  // The ladder encodes the same file several times; keep only the last decoded, flattened image.
  let cache: { srcPath: string; image: NativeImage } | null = null;

  const load = (srcPath: string): NativeImage => {
    if (cache && cache.srcPath === srcPath) return cache.image;
    cache = null;
    let image = nativeImage.createFromPath(srcPath);
    if (image.isEmpty()) {
      throw new Error('image_decode_failed');
    }
    const size = image.getSize();
    const bitmap = image.toBitmap();
    if (flattenPremultipliedOntoWhite(bitmap)) {
      image = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
    }
    cache = { srcPath, image };
    return image;
  };

  return {
    async encodeJpeg(srcPath, opts) {
      try {
        let image = load(srcPath);
        const { width, height } = image.getSize();
        const longEdge = Math.max(width, height);
        if (opts.maxLongEdge !== null && longEdge > opts.maxLongEdge) {
          const scale = opts.maxLongEdge / longEdge;
          image = image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'best',
          });
        }
        const out = image.getSize();
        return { data: image.toJPEG(opts.quality), width: out.width, height: out.height };
      } catch (err) {
        cache = null;
        throw err;
      }
    },
    release() {
      cache = null;
    },
  };
}

/** Reference-board renderer backed by nativeImage (main process only). */
export function createElectronBoardRenderer(): ReferenceBoardRenderer {
  const decode = (srcPath: string): NativeImage => {
    const image = nativeImage.createFromPath(srcPath);
    if (image.isEmpty()) throw new Error('image_decode_failed');
    return image;
  };
  return {
    size(srcPath) {
      return decode(srcPath).getSize();
    },
    loadResized(srcPath, width, height) {
      const image = decode(srcPath).resize({ width, height, quality: 'best' });
      const actual = image.getSize();
      const pixels = image.toBitmap();
      flattenPremultipliedOntoWhite(pixels);
      return { width: actual.width, height: actual.height, pixels };
    },
    encodeJpeg(bitmap, quality) {
      return nativeImage.createFromBitmap(bitmap.pixels, { width: bitmap.width, height: bitmap.height }).toJPEG(quality);
    },
  };
}
