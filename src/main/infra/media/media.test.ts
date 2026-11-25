import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import type { MediaLibrary } from '@shared/services';
import { hashBuffer, hashFile } from './hash';
import { cleanupTemp, createMediaLibrary } from './index';
import { getSkuDir, resolveSafe } from './sku-path';

function buildPngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length 13
  buf.writeUInt32BE(13, 8);
  // 'IHDR'
  buf.write('IHDR', 12, 4, 'ascii');
  // Dimensions
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Bit depth 8, color type 2 (truecolor), compression 0, filter 0, interlace 0
  buf.set([0x08, 0x02, 0x00, 0x00, 0x00], 24);
  // Dummy CRC
  buf.writeUInt32BE(0, 29);
  return buf;
}

function buildJpegBuffer(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, // SOI, APP0
    0x00, 0x04, 0x00, 0x00, // APP0 length 4
    0xff, 0xc0,             // SOF0
    0x00, 0x0b,             // length 11
    0x08,                   // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, // components
    0xff, 0xd9,             // EOI
  ]);
}

function buildWebpVp8Buffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 4, 'ascii');
  buf.write('VP8 ', 12, 4, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x00; // keyframe
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a; // start code
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

function buildWebpVp8lBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(17, 4);
  buf.write('WEBP', 8, 4, 'ascii');
  buf.write('VP8L', 12, 4, 'ascii');
  buf.writeUInt32LE(5, 16);
  buf[20] = 0x2f; // signature
  const val = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(val, 21);
  return buf;
}

function buildWebpVp8xBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 4, 'ascii');
  buf.write('VP8X', 12, 4, 'ascii');
  buf.writeUInt32LE(10, 16);
  // flags
  buf.writeUInt32LE(0, 20);
  const w = width - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  const h = height - 1;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

function buildMinimalMp4Buffer(): Buffer {
  const buf = Buffer.alloc(24);
  // ftyp box
  buf.writeUInt32BE(16, 0);
  buf.write('ftyp', 4, 4, 'ascii');
  buf.write('isom', 8, 4, 'ascii');
  buf.writeUInt32BE(512, 12);
  // moov box
  buf.writeUInt32BE(8, 16);
  buf.write('moov', 20, 4, 'ascii');
  return buf;
}

describe('Media Library and Safe Storage', () => {
  let tmpDir: string;
  let rootDir: string;
  let tempDir: string;
  let media: MediaLibrary;

  const MAX_SOURCE_BYTES = 5 * 1024 * 1024; // 5MB
  const MAX_SOURCE_PIXELS = 10_000_000; // 10M pixels
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-media-test-'));
    rootDir = path.join(tmpDir, 'library');
    tempDir = path.join(tmpDir, 'temp');

    media = createMediaLibrary({
      root: rootDir,
      tempDir,
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxSourcePixels: MAX_SOURCE_PIXELS,
      maxVideoBytes: MAX_VIDEO_BYTES,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('SKU validation and Directory', () => {
    it('accepts valid SKUs and rejects invalid/traversal/reserved names', () => {
      expect(getSkuDir(rootDir, 'TS-001')).toBe(path.join(rootDir, 'TS-001'));
      expect(getSkuDir(rootDir, 'hoodie_123')).toBe(path.join(rootDir, 'HOODIE_123'));
      expect(getSkuDir(rootDir, 'MUG-A_B')).toBe(path.join(rootDir, 'MUG-A_B'));

      // Traversal and invalid cases
      const invalidSkus = [
        '',
        '   ',
        '../x',
        '..\\x',
        'C:\\x',
        '\\\\server\\share',
        'abc\0def',
        '-leadingdash',
        '.leadingdot',
        'CON',
        'PRN',
        'AUX',
        'NUL',
        'COM1',
        'COM9',
        'LPT1',
        'LPT9',
      ];

      for (const sku of invalidSkus) {
        expect(() => getSkuDir(rootDir, sku)).toThrow(PodError);
      }
    });
  });

  describe('resolveSafe traversal & symlink/junction escape', () => {
    it('rejects traversal, drive letters, UNC, and NUL bytes', () => {
      const badPaths = [
        '../secret.txt',
        '..\\secret.txt',
        'sub/../../secret.txt',
        'C:\\escaped.txt',
        'D:/escaped.txt',
        '\\\\server\\share\\file.txt',
        '//server/share/file.txt',
        'bad\0file.txt',
      ];

      for (const p of badPaths) {
        expect(() => resolveSafe(rootDir, p)).toThrow(PodError);
      }
    });

    it('allows valid relative paths inside root', () => {
      const valid = resolveSafe(rootDir, 'TS-001/source/TS-001-original.png');
      expect(valid).toBe(path.join(rootDir, 'TS-001/source/TS-001-original.png'));
    });

    it('rejects junction escape pointing outside library root', () => {
      const outsideDir = path.join(tmpDir, 'outside');
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'confidential');

      const junctionLink = path.join(rootDir, 'outside_junction');

      try {
        fs.symlinkSync(outsideDir, junctionLink, 'junction');
      } catch {
        // Skip if OS denies junction creation
        return;
      }

      expect(() => resolveSafe(rootDir, 'outside_junction/secret.txt')).toThrow(PodError);
    });

    it('rejects symlink escape pointing outside library root when symlinks supported', () => {
      const outsideDir = path.join(tmpDir, 'outside-sym');
      fs.mkdirSync(outsideDir);
      const secretFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(secretFile, 'confidential');

      const symlinkPath = path.join(rootDir, 'symlink_escape');
      try {
        fs.symlinkSync(secretFile, symlinkPath, 'file');
      } catch {
        // Skip gracefully if the OS denies symlink creation (e.g. non-admin Windows)
        return;
      }

      expect(() => resolveSafe(rootDir, 'symlink_escape')).toThrow(PodError);
    });
  });

  describe('Image Header Validation', () => {
    it('parses minimal PNG fixture correctly', async () => {
      const file = path.join(tmpDir, 'test.png');
      fs.writeFileSync(file, buildPngBuffer(320, 240));

      const info = await media.validateImage(file);
      expect(info.mime).toBe('image/png');
      expect(info.width).toBe(320);
      expect(info.height).toBe(240);
      expect(info.bytes).toBe(33);
    });

    it('parses minimal JPEG fixture correctly', async () => {
      const file = path.join(tmpDir, 'test.jpg');
      fs.writeFileSync(file, buildJpegBuffer(640, 480));

      const info = await media.validateImage(file);
      expect(info.mime).toBe('image/jpeg');
      expect(info.width).toBe(640);
      expect(info.height).toBe(480);
    });

    it('parses minimal WEBP fixtures (VP8, VP8L, VP8X)', async () => {
      // VP8
      const vp8File = path.join(tmpDir, 'test-vp8.webp');
      fs.writeFileSync(vp8File, buildWebpVp8Buffer(100, 150));
      const vp8Info = await media.validateImage(vp8File);
      expect(vp8Info.mime).toBe('image/webp');
      expect(vp8Info.width).toBe(100);
      expect(vp8Info.height).toBe(150);

      // VP8L
      const vp8lFile = path.join(tmpDir, 'test-vp8l.webp');
      fs.writeFileSync(vp8lFile, buildWebpVp8lBuffer(200, 300));
      const vp8lInfo = await media.validateImage(vp8lFile);
      expect(vp8lInfo.mime).toBe('image/webp');
      expect(vp8lInfo.width).toBe(200);
      expect(vp8lInfo.height).toBe(300);

      // VP8X
      const vp8xFile = path.join(tmpDir, 'test-vp8x.webp');
      fs.writeFileSync(vp8xFile, buildWebpVp8xBuffer(400, 500));
      const vp8xInfo = await media.validateImage(vp8xFile);
      expect(vp8xInfo.mime).toBe('image/webp');
      expect(vp8xInfo.width).toBe(400);
      expect(vp8xInfo.height).toBe(500);
    });

    it('rejects wrong signature with .png extension', async () => {
      const file = path.join(tmpDir, 'fake.png');
      fs.writeFileSync(file, 'This is just plain text, not a PNG file');

      await expect(media.validateImage(file)).rejects.toThrow(PodError);
      try {
        await media.validateImage(file);
      } catch (err) {
        expect((err as PodError).code).toBe('INVALID_IMAGE');
      }
    });

    it('rejects oversize bytes before reading full file', async () => {
      const file = path.join(tmpDir, 'huge.png');
      // Create a file larger than MAX_SOURCE_BYTES
      const size = MAX_SOURCE_BYTES + 1024;
      const fd = fs.openSync(file, 'w');
      fs.writeSync(fd, Buffer.from('x'), 0, 1, size - 1);
      fs.closeSync(fd);

      await expect(media.validateImage(file)).rejects.toThrow(PodError);
      try {
        await media.validateImage(file);
      } catch (err) {
        expect((err as PodError).code).toBe('IMAGE_TOO_LARGE');
      }
    });

    it('rejects oversize pixels (decompression bomb guard)', async () => {
      const file = path.join(tmpDir, 'bomb.png');
      // 5000 x 5000 = 25M pixels > 10M maxSourcePixels
      fs.writeFileSync(file, buildPngBuffer(5000, 5000));

      await expect(media.validateImage(file)).rejects.toThrow(PodError);
      try {
        await media.validateImage(file);
      } catch (err) {
        expect((err as PodError).code).toBe('IMAGE_TOO_LARGE');
      }
    });
  });

  describe('Video Validation', () => {
    it('accepts valid minimal MP4 fixture with ftyp + moov', async () => {
      const part = media.newTempPath();
      fs.writeFileSync(part, buildMinimalMp4Buffer());

      const stored = await media.storeVideo(part, 'TS-001');
      expect(stored.mime).toBe('video/mp4');
      expect(stored.relPath).toBe('TS-001/videos/TS-001-video-001.mp4');
      expect(fs.existsSync(stored.absPath)).toBe(true);
      expect(fs.existsSync(part)).toBe(false); // Cleaned up
    });

    it('rejects text file renamed to .mp4 and cleans up temp', async () => {
      const part = media.newTempPath();
      fs.writeFileSync(part, 'Not an MP4 video content at all');

      await expect(media.storeVideo(part, 'TS-001')).rejects.toThrow(PodError);
      expect(fs.existsSync(part)).toBe(false); // Deleted on failure
    });

    it('rejects truncated MP4 box and cleans up temp', async () => {
      const part = media.newTempPath();
      const valid = buildMinimalMp4Buffer();
      // Truncate
      fs.writeFileSync(part, valid.subarray(0, 18));

      await expect(media.storeVideo(part, 'TS-001')).rejects.toThrow(PodError);
      expect(fs.existsSync(part)).toBe(false);
    });

    it('rejects empty video file and cleans up temp', async () => {
      const part = media.newTempPath();
      fs.writeFileSync(part, Buffer.alloc(0));

      await expect(media.storeVideo(part, 'TS-001')).rejects.toThrow(PodError);
      expect(fs.existsSync(part)).toBe(false);
    });
  });

  describe('SHA-256 Hashing', () => {
    it('matches node crypto SHA-256 digest', async () => {
      const content = Buffer.from('Testing SHA-256 streaming hash against crypto digest');
      const file = path.join(tmpDir, 'hash-test.dat');
      fs.writeFileSync(file, content);

      const expected = createHash('sha256').update(content).digest('hex');
      const actual = await hashFile(file);
      expect(actual).toBe(expected);
      expect(hashBuffer(content)).toBe(expected);
    });
  });

  describe('importSourceImage', () => {
    it('is byte-identical and subsequent imports get -original-2, -original-3', async () => {
      const pngBuf = buildPngBuffer(120, 80);
      const srcFile = path.join(tmpDir, 'source.png');
      fs.writeFileSync(srcFile, pngBuf);

      const expectedHash = createHash('sha256').update(pngBuf).digest('hex');

      // First import
      const f1 = await media.importSourceImage(srcFile, 'TS-001');
      expect(f1.relPath).toBe('TS-001/source/TS-001-original.png');
      expect(f1.sha256).toBe(expectedHash);
      expect(fs.readFileSync(f1.absPath)).toEqual(pngBuf);

      // Second import
      const f2 = await media.importSourceImage(srcFile, 'TS-001');
      expect(f2.relPath).toBe('TS-001/source/TS-001-original-2.png');
      expect(f2.sha256).toBe(expectedHash);
      expect(fs.readFileSync(f2.absPath)).toEqual(pngBuf);

      // Third import
      const f3 = await media.importSourceImage(srcFile, 'TS-001');
      expect(f3.relPath).toBe('TS-001/source/TS-001-original-3.png');
    });

    it('validates copied file and deletes copy if validation fails', async () => {
      // Create a valid image file
      const pngBuf = buildPngBuffer(100, 100);
      const srcFile = path.join(tmpDir, 'valid.png');
      fs.writeFileSync(srcFile, pngBuf);

      // Spy on validateImage: succeed on initial call, fail on copy validation
      let callCount = 0;
      const originalValidate = media.validateImage.bind(media);
      media.validateImage = async (p: string) => {
        callCount++;
        if (callCount === 2) {
          throw new PodError('INVALID_IMAGE', 'Corrupted on copy');
        }
        return originalValidate(p);
      };

      await expect(media.importSourceImage(srcFile, 'TS-009')).rejects.toThrow(PodError);

      // Verify that no copy remains in TS-009/source
      const targetCopy = path.join(rootDir, 'TS-009', 'source', 'TS-009-original.png');
      expect(fs.existsSync(targetCopy)).toBe(false);

      // Restore validateImage
      media.validateImage = originalValidate;
    });
  });

  describe('storeVideo increments and cleanup', () => {
    it('increments numbering from 001 to 002', async () => {
      const mp4Buf = buildMinimalMp4Buffer();

      const part1 = media.newTempPath();
      fs.writeFileSync(part1, mp4Buf);
      const v1 = await media.storeVideo(part1, 'TS-002');
      expect(v1.relPath).toBe('TS-002/videos/TS-002-video-001.mp4');

      const part2 = media.newTempPath();
      fs.writeFileSync(part2, mp4Buf);
      const v2 = await media.storeVideo(part2, 'TS-002');
      expect(v2.relPath).toBe('TS-002/videos/TS-002-video-002.mp4');
    });

    it('pre-create video-002 with a gap (001 missing) -> next is 003', async () => {
      const mp4Buf = buildMinimalMp4Buffer();
      const skuVideosDir = path.join(rootDir, 'GAP-001', 'videos');
      fs.mkdirSync(skuVideosDir, { recursive: true });

      // Pre-create 002 with a gap (001 missing)
      fs.writeFileSync(path.join(skuVideosDir, 'GAP-001-video-002.mp4'), mp4Buf);

      const part = media.newTempPath();
      fs.writeFileSync(part, mp4Buf);
      const v = await media.storeVideo(part, 'GAP-001');
      expect(v.relPath).toBe('GAP-001/videos/GAP-001-video-003.mp4');
    });

    it('pre-create 001 and an unrelated file -> 002', async () => {
      const mp4Buf = buildMinimalMp4Buffer();
      const skuVideosDir = path.join(rootDir, 'UNRELATED-001', 'videos');
      fs.mkdirSync(skuVideosDir, { recursive: true });

      // Pre-create 001 and an unrelated file
      fs.writeFileSync(path.join(skuVideosDir, 'UNRELATED-001-video-001.mp4'), mp4Buf);
      fs.writeFileSync(path.join(skuVideosDir, 'random-notes.txt'), 'notes');
      fs.writeFileSync(path.join(skuVideosDir, 'UNRELATED-001-video-abc.mp4'), 'not numeric');

      const part = media.newTempPath();
      fs.writeFileSync(part, mp4Buf);
      const v = await media.storeVideo(part, 'UNRELATED-001');
      expect(v.relPath).toBe('UNRELATED-001/videos/UNRELATED-001-video-002.mp4');
    });
  });

  describe('writeMetadata and writePromptSnapshot', () => {
    it('writes pretty JSON metadata atomically without auto-opening', async () => {
      const meta = { job: '123', status: 'done', tags: ['a', 'b'] };
      const stored = await media.writeMetadata('TS-001', 'TS-001-video-001', meta);

      expect(stored.relPath).toBe('TS-001/metadata/TS-001-video-001.json');
      const text = fs.readFileSync(stored.absPath, 'utf8');
      expect(JSON.parse(text)).toEqual(meta);
      expect(text).toContain('\n  "job": "123"');

      // Verify no leftover .tmp files
      const metaDir = path.join(rootDir, 'TS-001', 'metadata');
      const tmpFiles = fs.readdirSync(metaDir).filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('writes UTF-8 markdown prompt snapshot atomically and appends -2, -3 on duplicates', async () => {
      const prompt1 = '# Prompt V1\n\nA product review video for TS-001';
      const stored1 = await media.writePromptSnapshot('TS-001', 'v2', prompt1);

      expect(stored1.relPath).toBe('TS-001/prompts/TS-001-prompt-v2.md');
      expect(fs.readFileSync(stored1.absPath, 'utf8')).toBe(prompt1);

      // Second write with same SKU and label -> appends -2 (never silently overwrites)
      const prompt2 = '# Prompt V2 Revised\n\nUpdated prompt';
      const stored2 = await media.writePromptSnapshot('TS-001', 'v2', prompt2);

      expect(stored2.relPath).toBe('TS-001/prompts/TS-001-prompt-v2-2.md');
      expect(fs.readFileSync(stored2.absPath, 'utf8')).toBe(prompt2);
      expect(fs.readFileSync(stored1.absPath, 'utf8')).toBe(prompt1); // Original unchanged

      // Third write -> appends -3
      const prompt3 = '# Prompt V2 Third';
      const stored3 = await media.writePromptSnapshot('TS-001', 'v2', prompt3);
      expect(stored3.relPath).toBe('TS-001/prompts/TS-001-prompt-v2-3.md');

      // Verify no leftover .tmp files
      const promptsDir = path.join(rootDir, 'TS-001', 'prompts');
      const tmpFiles = fs.readdirSync(promptsDir).filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('cleanupTemp', () => {
    it('removes only old .part files', () => {
      const oldPart = media.newTempPath();
      fs.writeFileSync(oldPart, 'old');
      // Set mtime to 1 hour ago
      const oneHourAgo = (Date.now() - 3600 * 1000) / 1000;
      fs.utimesSync(oldPart, oneHourAgo, oneHourAgo);

      const newPart = media.newTempPath();
      fs.writeFileSync(newPart, 'new');

      const otherFile = path.join(tempDir, 'keep_me.txt');
      fs.writeFileSync(otherFile, 'text');
      fs.utimesSync(otherFile, oneHourAgo, oneHourAgo);

      // Cleanup files older than 30 minutes
      const removed = cleanupTemp(tempDir, 30 * 60 * 1000);
      expect(removed).toBe(1);

      expect(fs.existsSync(oldPart)).toBe(false);
      expect(fs.existsSync(newPart)).toBe(true);
      expect(fs.existsSync(otherFile)).toBe(true);
    });
  });
});
