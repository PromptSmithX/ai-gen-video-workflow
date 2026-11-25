import fs from 'node:fs';
import type { ImageInfo, ImageMime } from '@shared/domain';
import { PodError } from '@shared/errors';

interface Dimensions {
  width: number;
  height: number;
  mime: ImageMime;
}

/**
 * Checks PNG header and extracts dimensions from IHDR chunk.
 */
function parsePng(buf: Buffer): Dimensions | null {
  // Signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length < 24 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    return null;
  }

  // Chunk type at offset 12: 'IHDR'
  const chunkType = buf.toString('ascii', 12, 16);
  if (chunkType !== 'IHDR') {
    return null;
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return null;
  }

  return { width, height, mime: 'image/png' };
}

/**
 * Checks JPEG header and parses markers for SOF dimensions.
 */
function parseJpeg(buf: Buffer): Dimensions | null {
  // Must start with SOI: FF D8 FF
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return null;
  }

  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      return null;
    }
    // Skip padding 0xFF bytes
    while (offset < buf.length && buf[offset] === 0xff) {
      offset++;
    }
    if (offset >= buf.length) {
      return null;
    }

    const marker = buf[offset++];
    if (marker === undefined) {
      return null;
    }
    // Standalone markers: SOI (0xD8), EOI (0xD9)
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    // SOS (0xDA): entropy-coded scan data begins, SOF would have appeared before SOS
    if (marker === 0xda) {
      break;
    }

    if (offset + 2 > buf.length) {
      return null;
    }
    const len = buf.readUInt16BE(offset);

    // SOF markers: SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2), SOF3 (0xC3),
    // SOF5 (0xC5), SOF6 (0xC6), SOF7 (0xC7), SOF9 (0xC9), SOF10 (0xCA),
    // SOF11 (0xCB), SOF13 (0xCD), SOF14 (0xCE), SOF15 (0xCF)
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      if (offset + len > buf.length || len < 7) {
        return null;
      }
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) {
        return null;
      }
      return { width, height, mime: 'image/jpeg' };
    }

    offset += len;
  }

  return null;
}

/**
 * Checks WEBP header and parses VP8, VP8L, or VP8X dimensions.
 */
function parseWebP(buf: Buffer): Dimensions | null {
  if (buf.length < 16) {
    return null;
  }

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunkType = buf.toString('ascii', 12, 16);

  if (chunkType === 'VP8 ') {
    if (buf.length < 30) return null;
    const b20 = buf[20];
    const b21 = buf[21];
    const b22 = buf[22];
    const b23 = buf[23];
    const b24 = buf[24];
    const b25 = buf[25];
    if (
      b20 === undefined ||
      b21 === undefined ||
      b22 === undefined ||
      b23 === undefined ||
      b24 === undefined ||
      b25 === undefined
    ) {
      return null;
    }
    // Keyframe bit: bit 0 of 3-byte frame tag at offset 20
    const frameTag = b20 | (b21 << 8) | (b22 << 16);
    const isKeyframe = (frameTag & 1) === 0;
    if (!isKeyframe) return null;

    // Start code at 23..25: 9D 01 2A
    if (b23 !== 0x9d || b24 !== 0x01 || b25 !== 0x2a) {
      return null;
    }

    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { width, height, mime: 'image/webp' };
  }

  if (chunkType === 'VP8L') {
    if (buf.length < 25) return null;
    const b20 = buf[20];
    const b21 = buf[21];
    const b22 = buf[22];
    const b23 = buf[23];
    const b24 = buf[24];
    if (
      b20 === undefined ||
      b21 === undefined ||
      b22 === undefined ||
      b23 === undefined ||
      b24 === undefined
    ) {
      return null;
    }
    // Signature byte at offset 20 must be 0x2F
    if (b20 !== 0x2f) return null;

    const val = (b21 | (b22 << 8) | (b23 << 16) | (b24 << 24)) >>> 0;

    const width = (val & 0x3fff) + 1;
    const height = ((val >>> 14) & 0x3fff) + 1;
    return { width, height, mime: 'image/webp' };
  }

  if (chunkType === 'VP8X') {
    if (buf.length < 30) return null;
    const b24 = buf[24];
    const b25 = buf[25];
    const b26 = buf[26];
    const b27 = buf[27];
    const b28 = buf[28];
    const b29 = buf[29];
    if (
      b24 === undefined ||
      b25 === undefined ||
      b26 === undefined ||
      b27 === undefined ||
      b28 === undefined ||
      b29 === undefined
    ) {
      return null;
    }
    const width = 1 + b24 + (b25 << 8) + (b26 << 16);
    const height = 1 + b27 + (b28 << 8) + (b29 << 16);
    return { width, height, mime: 'image/webp' };
  }

  return null;
}

/**
 * Validates image header (PNG, JPEG, WEBP), enforcing maxSourceBytes and maxSourcePixels
 * (decompression-bomb guard) before reading the whole file.
 */
export async function validateImageHeader(
  absPath: string,
  maxSourceBytes: number,
  maxSourcePixels: number,
): Promise<ImageInfo> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    throw new PodError('INVALID_IMAGE', 'Could not access image file', { cause: err });
  }

  if (stat.size === 0) {
    throw new PodError('INVALID_IMAGE', 'Image file is empty');
  }

  // Enforce maxSourceBytes BEFORE reading file
  if (stat.size > maxSourceBytes) {
    throw new PodError('IMAGE_TOO_LARGE', 'Image file exceeds maximum byte size limit');
  }

  // Read only initial header bytes (up to 64KB for JPEG SOF marker or full file if smaller)
  const headerSize = Math.min(stat.size, 65536);
  const buffer = Buffer.alloc(headerSize);

  const fd = fs.openSync(absPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, headerSize, 0);
  } finally {
    fs.closeSync(fd);
  }

  const parsed = parsePng(buffer) ?? parseJpeg(buffer) ?? parseWebP(buffer);

  if (!parsed) {
    throw new PodError('INVALID_IMAGE', 'File is not a valid PNG, JPEG, or WEBP image');
  }

  // Enforce maxSourcePixels BEFORE reading the whole file (decompression bomb guard)
  const totalPixels = parsed.width * parsed.height;
  if (totalPixels > maxSourcePixels) {
    throw new PodError('IMAGE_TOO_LARGE', 'Image dimensions exceed maximum pixel limit');
  }

  return {
    mime: parsed.mime,
    width: parsed.width,
    height: parsed.height,
    bytes: stat.size,
  };
}
