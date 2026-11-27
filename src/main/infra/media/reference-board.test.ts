import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOARD_WIDTH,
  INTERIOR_SHARE,
  buildReferenceBoard,
  composeReferenceBoard,
  layoutReferenceBoard,
  type BoardBitmap,
  type ReferenceBoardRenderer,
} from './reference-board';

const solid = (width: number, height: number, value: number): BoardBitmap => ({
  width,
  height,
  pixels: Buffer.alloc(width * height * 4, value),
});

const px = (b: BoardBitmap, x: number, y: number): number => b.pixels[(y * b.width + x) * 4]!;

describe('reference board layout', () => {
  it('cover left, interior right and larger, no overlap, all inside the board', () => {
    const l = layoutReferenceBoard({ width: 3300, height: 2550 }, { width: 3300, height: 2550 });
    expect(l.width).toBe(BOARD_WIDTH);
    expect(l.cover.x + l.cover.width).toBeLessThan(l.divider.x);
    expect(l.divider.x + l.divider.width).toBeLessThan(l.interior.x);
    expect(l.interior.x + l.interior.width).toBeLessThanOrEqual(l.width);
    expect(l.interior.width).toBeGreaterThan(l.cover.width);
    expect(l.interior.width / (l.interior.width + l.cover.width)).toBeCloseTo(INTERIOR_SHARE, 1);
    for (const r of [l.cover, l.interior]) {
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.height).toBeLessThanOrEqual(l.height);
    }
  });

  it('keeps each panel aspect ratio and caps very tall artwork', () => {
    const l = layoutReferenceBoard({ width: 1000, height: 800 }, { width: 500, height: 4000 });
    expect(l.cover.height / l.cover.width).toBeCloseTo(0.8, 2);
    expect(l.interior.height).toBeLessThanOrEqual(1800);
    expect(l.interior.height / l.interior.width).toBeCloseTo(8, 0);
  });
});

describe('reference board composition', () => {
  it('white background, grey divider, panels copied to their rects', () => {
    const l = layoutReferenceBoard({ width: 400, height: 300 }, { width: 400, height: 300 });
    const board = composeReferenceBoard(l, solid(l.cover.width, l.cover.height, 10), solid(l.interior.width, l.interior.height, 20));
    expect(px(board, 2, 2)).toBe(255);
    expect(px(board, l.divider.x + 1, l.divider.y + 5)).toBe(128);
    expect(board.pixels[((l.divider.y + 5) * board.width + l.divider.x) * 4 + 3]).toBe(255);
    expect(px(board, l.cover.x + 3, l.cover.y + 3)).toBe(10);
    expect(px(board, l.interior.x + l.interior.width - 1, l.interior.y + l.interior.height - 1)).toBe(20);
  });

  it('a decoder returning a slightly smaller bitmap is clipped, never overflows', () => {
    const l = layoutReferenceBoard({ width: 400, height: 300 }, { width: 400, height: 300 });
    const board = composeReferenceBoard(
      l,
      solid(l.cover.width - 1, l.cover.height - 1, 10),
      solid(l.interior.width + 5, l.interior.height + 5, 20)
    );
    expect(board.pixels.length).toBe(l.width * l.height * 4);
    expect(px(board, l.interior.x + l.interior.width, l.interior.y)).toBe(255);
  });

  it('buildReferenceBoard writes the encoded JPEG and loads cover before interior', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
    const order: string[] = [];
    const renderer: ReferenceBoardRenderer = {
      size: () => ({ width: 300, height: 200 }),
      loadResized: (p, w, h) => {
        order.push(p);
        return solid(w, h, 50);
      },
      encodeJpeg: (b) => Buffer.from(`JPEG ${b.width}x${b.height}`),
    };
    const out = path.join(dir, 'board.jpg');
    const res = buildReferenceBoard({ coverPath: 'cover', interiorPath: 'interior', outPath: out, renderer });
    expect(order).toEqual(['cover', 'interior']);
    expect(fs.readFileSync(out, 'utf-8')).toBe(`JPEG ${res.width}x${res.height}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
