import fs from 'node:fs';
import { PodError } from '@shared/errors';

/**
 * Validates MP4 / ISO-BMFF container:
 * - First box type must be 'ftyp' with a sane size (>= 8 and <= file size).
 * - Walking top-level boxes must find an 'moov' or 'mdat' box.
 * - Rejects empty files, truncated files, or files exceeding maxVideoBytes.
 */
export async function validateMp4Video(absPath: string, maxVideoBytes: number): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    throw new PodError('DOWNLOAD_FAILED', 'Could not access video file', { cause: err });
  }

  if (stat.size < 8) {
    throw new PodError('DOWNLOAD_FAILED', 'Video file is empty or too small to be an MP4');
  }

  if (stat.size > maxVideoBytes) {
    throw new PodError('DOWNLOAD_FAILED', 'Video file exceeds maximum size limit');
  }

  // Open file to walk box headers
  const fd = fs.openSync(absPath, 'r');
  try {
    let offset = 0;
    let hasFtyp = false;
    let hasMoovOrMdat = false;
    let isFirst = true;

    const headerBuf = Buffer.alloc(16);

    while (offset < stat.size) {
      if (offset + 8 > stat.size) {
        throw new PodError('DOWNLOAD_FAILED', 'Truncated box header in MP4 file');
      }

      fs.readSync(fd, headerBuf, 0, 8, offset);
      let size = headerBuf.readUInt32BE(0);
      const type = headerBuf.toString('ascii', 4, 8);

      let boxHeaderLength = 8;
      if (size === 1) {
        // 64-bit extended size
        if (offset + 16 > stat.size) {
          throw new PodError('DOWNLOAD_FAILED', 'Truncated 64-bit box in MP4 file');
        }
        fs.readSync(fd, headerBuf, 8, 8, offset + 8);
        const high = headerBuf.readUInt32BE(8);
        const low = headerBuf.readUInt32BE(12);
        size = high * 2 ** 32 + low;
        boxHeaderLength = 16;
      } else if (size === 0) {
        // Box extends to end of file
        size = stat.size - offset;
      }

      if (size < boxHeaderLength || offset + size > stat.size) {
        throw new PodError('DOWNLOAD_FAILED', 'Corrupt or truncated box size in MP4 file');
      }

      if (isFirst) {
        if (type !== 'ftyp') {
          throw new PodError('DOWNLOAD_FAILED', 'First MP4 box must be ftyp');
        }
        hasFtyp = true;
        isFirst = false;
      }

      if (type === 'moov' || type === 'mdat') {
        hasMoovOrMdat = true;
      }

      offset += size;
    }

    if (!hasFtyp || !hasMoovOrMdat) {
      throw new PodError('DOWNLOAD_FAILED', 'Invalid MP4 file: missing required ftyp and moov/mdat boxes');
    }
  } finally {
    fs.closeSync(fd);
  }
}
