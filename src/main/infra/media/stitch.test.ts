import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import type { Logger } from '@shared/services';
import { buildStitchArgs, createFfmpegStitcher, parseProbe, type ProbedClip } from './stitch';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

const A: ProbedClip = { width: 1024, height: 848, fps: 24, durationSec: 10, hasAudio: true };

describe('stitch args', () => {
  it('scales/pads clip B to clip A, silence for a clip without audio, explicit mp4 muxer', () => {
    const args = buildStitchArgs({
      firstPath: 'a.mp4',
      secondPath: 'b.mp4',
      outputPath: 'out.part',
      first: A,
      second: { width: 1280, height: 720, fps: 30, durationSec: 8.5, hasAudio: false },
    });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('[1:v]scale=1024:848:force_original_aspect_ratio=decrease,pad=1024:848');
    expect(filter).toContain('fps=24');
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=8.500[a1]');
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
    expect(args.slice(-3)).toEqual(['-f', 'mp4', 'out.part']);
  });

  it('parses ffprobe JSON', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1024, height: 848, r_frame_rate: '24/1', duration: '10.0' },
        { codec_type: 'audio' },
      ],
    });
    expect(parseProbe(json)).toEqual(A);
    expect(() => parseProbe(JSON.stringify({ streams: [] }))).toThrow();
  });
});

const FFMPEG = process.env['FFMPEG_EXE'] ?? 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const FFPROBE = process.env['FFPROBE_EXE'] ?? 'C:\\ffmpeg\\bin\\ffprobe.exe';
const hasFfmpeg = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);

describe.skipIf(!hasFfmpeg)('stitch with real ffmpeg', () => {
  it('joins clips of different size/fps, one silent, under a Vietnamese path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Hỏi đáp-stitch-'));
    try {
      const a = path.join(dir, 'clip a.mp4');
      const b = path.join(dir, 'clip b.mp4');
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', a]);
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=1',
        '-pix_fmt', 'yuv420p', b]);
      const out = path.join(dir, 'out.part');
      await createFfmpegStitcher({ ffmpegExe: FFMPEG, ffprobeExe: FFPROBE, logger }).stitch({
        firstPath: a,
        secondPath: b,
        outputPath: out,
      });
      const probed = parseProbe(
        execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], { encoding: 'utf8' })
      );
      expect(probed.width).toBe(320);
      expect(probed.height).toBe(240);
      expect(probed.hasAudio).toBe(true);
      expect(probed.durationSec).toBeGreaterThan(1.8);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a broken input fails with VIDEO_STITCH_FAILED and leaves no output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-bad-'));
    try {
      const bad = path.join(dir, 'bad.mp4');
      fs.writeFileSync(bad, 'not a video');
      const out = path.join(dir, 'out.part');
      await expect(
        createFfmpegStitcher({ ffmpegExe: FFMPEG, ffprobeExe: FFPROBE, logger }).stitch({
          firstPath: bad,
          secondPath: bad,
          outputPath: out,
        })
      ).rejects.toSatisfy((e: unknown) => e instanceof PodError && e.code === 'VIDEO_STITCH_FAILED');
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
