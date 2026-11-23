/**
 * Minimal valid MP4 container generator for offline testing and mock provider.
 * Produces a tiny MP4 buffer containing valid ftyp, moov, and mdat boxes.
 */

function createBox(type: string, payload: Buffer): Buffer {
  const size = payload.length + 8;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

/**
 * Creates a minimal valid MP4 file containing ftyp, moov (with mvhd), and mdat boxes.
 */
export function createMinimalValidMp4(): Buffer {
  // 1. ftyp box: major_brand 'isom', minor_version 0x00000200, compatible_brands 'isom', 'mp42'
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write('isom', 0, 4, 'ascii');
  ftypPayload.writeUInt32BE(0x00000200, 4);
  ftypPayload.write('isom', 8, 4, 'ascii');
  ftypPayload.write('mp42', 12, 4, 'ascii');
  const ftypBox = createBox('ftyp', ftypPayload);

  // 2. mvhd box inside moov
  // mvhd size = 108 bytes
  const mvhdPayload = Buffer.alloc(100);
  // version (1) + flags (3) = 0
  mvhdPayload.writeUInt32BE(0, 0);
  // creation time (4) = 0
  mvhdPayload.writeUInt32BE(0, 4);
  // modification time (4) = 0
  mvhdPayload.writeUInt32BE(0, 8);
  // timescale (4) = 1000
  mvhdPayload.writeUInt32BE(1000, 12);
  // duration (4) = 1000
  mvhdPayload.writeUInt32BE(1000, 16);
  // rate (4) = 0x00010000 (1.0)
  mvhdPayload.writeUInt32BE(0x00010000, 20);
  // volume (2) = 0x0100 (1.0)
  mvhdPayload.writeUInt16BE(0x0100, 24);
  // reserved (10) = 0 at offset 26
  // matrix (36) unity matrix at offset 36
  mvhdPayload.writeUInt32BE(0x00010000, 36);
  mvhdPayload.writeUInt32BE(0x00010000, 52);
  mvhdPayload.writeUInt32BE(0x40000000, 68);
  // pre-defined (24) = 0 at offset 72
  // next track id (4) = 2 at offset 96
  mvhdPayload.writeUInt32BE(2, 96);
  const mvhdBox = createBox('mvhd', mvhdPayload);

  // moov box wrapping mvhd
  const moovBox = createBox('moov', mvhdBox);

  // 3. mdat box containing dummy sample bytes
  const mdatPayload = Buffer.alloc(16, 0xaa);
  const mdatBox = createBox('mdat', mdatPayload);

  return Buffer.concat([ftypBox, moovBox, mdatBox]);
}

/**
 * Checks whether a buffer starts with a valid MP4 ftyp box signature.
 */
export function isValidMp4Buffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const boxType = buf.toString('ascii', 4, 8);
  return boxType === 'ftyp';
}
