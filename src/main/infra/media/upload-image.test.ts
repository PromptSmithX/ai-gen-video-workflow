import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import { flattenPremultipliedOntoWhite } from './electron-image-encoder';
import { prepareUploadImage, type UploadImageEncoder } from './upload-image';

/** Fake encoder: output size = width*height*quality/100 bytes / divisor. Records every call. */
function fakeEncoder(width: number, height: number, divisor: number) {
  const calls: Array<{ maxLongEdge: number | null; quality: number }> = [];
  let released = 0;
  const encoder: UploadImageEncoder = {
    async encodeJpeg(_src, opts) {
      calls.push(opts);
      let w = width;
      let h = height;
      const long = Math.max(w, h);
      if (opts.maxLongEdge !== null && long > opts.maxLongEdge) {
        const s = opts.maxLongEdge / long;
        w = Math.round(w * s);
        h = Math.round(h * s);
      }
      const bytes = Math.ceil((w * h * opts.quality) / 100 / divisor);
      return { data: Buffer.alloc(bytes, 0xff), width: w, height: h };
    },
    release() {
      released++;
    },
  };
  return { encoder, calls, released: () => released };
}

describe('prepareUploadImage', () => {
  let dir: string;
  let src: string;
  let n = 0;
  const newTempPath = () => path.join(dir, `tmp-${n++}.part`);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-upload-'));
    src = path.join(dir, 'cover.png');
    fs.writeFileSync(src, Buffer.alloc(10_000, 1));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passes a file within the limit through untouched (no encode, no temp file)', async () => {
    const f = fakeEncoder(1000, 1000, 1);
    const r = await prepareUploadImage({ srcPath: src, fileName: 'cover.png', maxBytes: 10_000, newTempPath, encoder: f.encoder });
    expect(r.transcoded).toBe(false);
    expect(r.path).toBe(src);
    expect(r.fileName).toBe('cover.png');
    expect(f.calls).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual(['cover.png']);
  });

  it('passes through when no encoder is configured', async () => {
    const r = await prepareUploadImage({ srcPath: src, fileName: 'cover.png', maxBytes: 10, newTempPath, encoder: undefined });
    expect(r.transcoded).toBe(false);
    expect(r.path).toBe(src);
  });

  it('keeps full resolution when a high JPEG quality already fits', async () => {
    // 100x100 @ q95 = 9500 bytes > 0.95*9000=8550; q92 = 9200; q90 = 9000 -> all too big at full size.
    // 100x100 with divisor 2: q95 = 4750 <= 8550 -> first step wins.
    const f = fakeEncoder(100, 100, 2);
    const r = await prepareUploadImage({ srcPath: src, fileName: 'cover.png', maxBytes: 9000, newTempPath, encoder: f.encoder });
    expect(r.transcoded).toBe(true);
    expect(r.quality).toBe(95);
    expect(r.width).toBe(100);
    expect(r.fileName).toBe('cover.jpg');
    expect(fs.statSync(r.path).size).toBe(r.uploadBytes);
    expect(r.uploadBytes).toBeLessThanOrEqual(9000);
    // original untouched
    expect(fs.readFileSync(src).equals(Buffer.alloc(10_000, 1))).toBe(true);
    r.cleanup();
    expect(fs.existsSync(r.path)).toBe(false);
    expect(f.released()).toBe(1);
  });

  it('downscales only as far as needed and never upscales', async () => {
    // 8000x6000, divisor 1000: full q95 = 45600; 6000-edge q92 = 6000*4500*.92/1000 = 24840;
    // 5000 -> 17250; 4096 -> ~11577. Limit 15000 -> target 14250 -> 4096 step wins.
    fs.writeFileSync(src, Buffer.alloc(100_000, 1));
    const f = fakeEncoder(8000, 6000, 1000);
    const r = await prepareUploadImage({ srcPath: src, fileName: 'a.webp', maxBytes: 15_000, newTempPath, encoder: f.encoder });
    expect(r.transcoded).toBe(true);
    expect(r.width).toBe(4096);
    expect(r.quality).toBe(92);
    expect(r.uploadBytes).toBeLessThanOrEqual(15_000 * 0.95);
  });

  it('skips downscale steps larger than the image itself', async () => {
    // 3000x3000: steps 6000/5000/4096/3072 would not shrink it and are skipped; 2560/2048 still do not fit
    // -> IMAGE_TOO_LARGE.
    const f = fakeEncoder(3000, 3000, 1);
    await expect(
      prepareUploadImage({ srcPath: src, fileName: 'c.png', maxBytes: 5000, newTempPath, encoder: f.encoder })
    ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(f.calls.every((c) => c.maxLongEdge === null || c.maxLongEdge < 3000)).toBe(true);
    expect(f.calls.map((c) => c.maxLongEdge)).toEqual([null, null, null, 2560, 2048, 2048]);
    expect(fs.readdirSync(dir)).toEqual(['cover.png']);
    expect(f.released()).toBe(1);
  });

  it('maps encoder failures to INVALID_IMAGE', async () => {
    const encoder: UploadImageEncoder = {
      encodeJpeg: async () => {
        throw new Error('boom');
      },
    };
    const err = await prepareUploadImage({ srcPath: src, fileName: 'c.png', maxBytes: 10, newTempPath, encoder }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(PodError);
    expect((err as PodError).code).toBe('INVALID_IMAGE');
  });
});

describe('flattenPremultipliedOntoWhite', () => {
  it('turns transparent pixels white and leaves opaque pixels alone', () => {
    // BGRA premultiplied: opaque red, fully transparent, 50% black
    const px = Buffer.from([0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 128]);
    expect(flattenPremultipliedOntoWhite(px)).toBe(true);
    expect([...px]).toEqual([0, 0, 255, 255, 255, 255, 255, 255, 127, 127, 127, 255]);
  });

  it('reports no change for a fully opaque bitmap', () => {
    const px = Buffer.from([10, 20, 30, 255]);
    expect(flattenPremultipliedOntoWhite(px)).toBe(false);
  });
});
