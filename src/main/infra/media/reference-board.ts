import fs from 'node:fs';

/**
 * "Reference board" for calendar jobs where Muse draws the interior page itself: ONE image with the front cover on
 * the LEFT and the interior page on the RIGHT, separated by a clear gap and a divider line.
 *
 * Why one image instead of two attachments: with two separate images of the same art style Muse cannot tell which is
 * which and blends the cover's motifs into the interior page. A single board whose panels the prompt names by position
 * ("LEFT panel = front cover, RIGHT panel = inside page") keeps them apart. The interior panel is drawn larger because
 * its details (month title, date grid) are the harder ones to reproduce.
 */

export interface BoardBitmap {
  width: number;
  height: number;
  /** 4 bytes per pixel, opaque (alpha already flattened onto white). Channel order is whatever the renderer uses. */
  pixels: Buffer;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardLayout {
  width: number;
  height: number;
  cover: Rect;
  interior: Rect;
  divider: Rect;
}

export interface ReferenceBoardRenderer {
  /** Natural pixel size of an image file. Throws when the file cannot be decoded. */
  size(srcPath: string): { width: number; height: number };
  /** Decodes and resizes to exactly width x height; transparent pixels flattened onto white. */
  loadResized(srcPath: string, width: number, height: number): BoardBitmap;
  encodeJpeg(bitmap: BoardBitmap, quality: number): Buffer;
}

export const BOARD_WIDTH = 2400;
const MARGIN = 48;
const GAP = 96;
const DIVIDER_WIDTH = 6;
/** Share of the inner width given to the interior page panel. */
export const INTERIOR_SHARE = 0.6;
/** No panel may be taller than this (very tall portrait artwork would otherwise make a huge board). */
const MAX_PANEL_HEIGHT = 1800;

/** Pure layout: panels side by side, vertically centred, interior panel ~60% of the inner width. */
export function layoutReferenceBoard(
  cover: { width: number; height: number },
  interior: { width: number; height: number }
): BoardLayout {
  const inner = BOARD_WIDTH - 2 * MARGIN - GAP;
  const fit = (src: { width: number; height: number }, maxW: number): { width: number; height: number } => {
    let width = Math.round(maxW);
    let height = Math.round((src.height / src.width) * width);
    if (height > MAX_PANEL_HEIGHT) {
      height = MAX_PANEL_HEIGHT;
      width = Math.round((src.width / src.height) * height);
    }
    return { width: Math.max(1, width), height: Math.max(1, height) };
  };
  const c = fit(cover, inner * (1 - INTERIOR_SHARE));
  const i = fit(interior, inner * INTERIOR_SHARE);
  const height = Math.max(c.height, i.height) + 2 * MARGIN;
  const coverX = MARGIN + Math.round((inner * (1 - INTERIOR_SHARE) - c.width) / 2);
  const interiorX = MARGIN + Math.round(inner * (1 - INTERIOR_SHARE)) + GAP + Math.round((inner * INTERIOR_SHARE - i.width) / 2);
  const dividerX = MARGIN + Math.round(inner * (1 - INTERIOR_SHARE)) + Math.round((GAP - DIVIDER_WIDTH) / 2);
  return {
    width: BOARD_WIDTH,
    height,
    cover: { x: coverX, y: Math.round((height - c.height) / 2), width: c.width, height: c.height },
    interior: { x: interiorX, y: Math.round((height - i.height) / 2), width: i.width, height: i.height },
    divider: { x: dividerX, y: MARGIN, width: DIVIDER_WIDTH, height: height - 2 * MARGIN },
  };
}

/** Copies `src` into `r` (clipped to the rect, in case the decoder returned a slightly different size). */
function blit(dst: BoardBitmap, src: BoardBitmap, r: Rect): void {
  const w = Math.min(src.width, r.width);
  const h = Math.min(src.height, r.height);
  for (let row = 0; row < h; row++) {
    const from = row * src.width * 4;
    src.pixels.copy(dst.pixels, ((r.y + row) * dst.width + r.x) * 4, from, from + w * 4);
  }
}

function fillRect(dst: BoardBitmap, r: Rect, value: number): void {
  for (let row = r.y; row < r.y + r.height; row++) {
    const start = (row * dst.width + r.x) * 4;
    dst.pixels.fill(value, start, start + r.width * 4);
  }
}

/** Pure composition onto a white board (channel-order agnostic: white and grey have equal channels). */
export function composeReferenceBoard(layout: BoardLayout, cover: BoardBitmap, interior: BoardBitmap): BoardBitmap {
  const board: BoardBitmap = {
    width: layout.width,
    height: layout.height,
    pixels: Buffer.alloc(layout.width * layout.height * 4, 255),
  };
  fillRect(board, layout.divider, 128);
  for (let row = layout.divider.y; row < layout.divider.y + layout.divider.height; row++) {
    for (let col = layout.divider.x; col < layout.divider.x + layout.divider.width; col++) {
      board.pixels[(row * board.width + col) * 4 + 3] = 255; // keep the divider opaque
    }
  }
  blit(board, cover, layout.cover);
  blit(board, interior, layout.interior);
  return board;
}

/** Builds the board as a JPEG at `outPath`. The library originals are only read. */
export function buildReferenceBoard(opts: {
  coverPath: string;
  interiorPath: string;
  outPath: string;
  renderer: ReferenceBoardRenderer;
  quality?: number;
}): { path: string; width: number; height: number; layout: BoardLayout } {
  const layout = layoutReferenceBoard(opts.renderer.size(opts.coverPath), opts.renderer.size(opts.interiorPath));
  const cover = opts.renderer.loadResized(opts.coverPath, layout.cover.width, layout.cover.height);
  const interior = opts.renderer.loadResized(opts.interiorPath, layout.interior.width, layout.interior.height);
  const board = composeReferenceBoard(layout, cover, interior);
  fs.writeFileSync(opts.outPath, opts.renderer.encodeJpeg(board, opts.quality ?? 92));
  return { path: opts.outPath, width: layout.width, height: layout.height, layout };
}
