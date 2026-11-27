import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { PodError } from '@shared/errors';
import type { Logger } from '@shared/services';

/**
 * Joins clip A (front cover) and clip B (inside page) of a two-clip calendar job into one MP4 with a hard cut.
 * Clip B is scaled/padded to clip A's frame size and frame rate; a clip without audio gets silence so the
 * concat filter always has one audio stream per segment. Uses the ffmpeg/ffprobe bundled with the compositor.
 */
export interface VideoStitcher {
  stitch(input: { firstPath: string; secondPath: string; outputPath: string }): Promise<void>;
}

export interface ProbedClip {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Pure: ffmpeg arguments for the hard-cut concat. Exported for tests. */
export function buildStitchArgs(opts: {
  firstPath: string;
  secondPath: string;
  outputPath: string;
  first: ProbedClip;
  second: ProbedClip;
}): string[] {
  const w = even(opts.first.width);
  const h = even(opts.first.height);
  const fps = opts.first.fps > 0 && opts.first.fps <= 120 ? Number(opts.first.fps.toFixed(3)) : 24;
  const video = (i: number): string =>
    `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`;
  const audio = (i: number, clip: ProbedClip): string =>
    clip.hasAudio
      ? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${Math.max(0.1, clip.durationSec).toFixed(3)}[a${i}]`;
  const filter = [
    video(0),
    video(1),
    audio(0, opts.first),
    audio(1, opts.second),
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
  ].join(';');
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    opts.firstPath,
    '-i',
    opts.secondPath,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    // Explicit muxer: the caller writes to a temp file that may not end in .mp4.
    '-f',
    'mp4',
    opts.outputPath,
  ];
}

/** Pure: parses `ffprobe -show_streams -show_format -of json` output. */
export function parseProbe(json: string): ProbedClip {
  const data = JSON.parse(json) as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string };
  };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s['codec_type'] === 'video');
  if (!v) throw new Error('no_video_stream');
  const [num, den] = String(v['r_frame_rate'] ?? '24/1').split('/');
  const fps = Number(den) > 0 ? Number(num) / Number(den) : Number(num);
  const duration = Number(v['duration'] ?? data.format?.duration ?? 0);
  return {
    width: Number(v['width']),
    height: Number(v['height']),
    fps: Number.isFinite(fps) && fps > 0 ? fps : 24,
    durationSec: Number.isFinite(duration) ? duration : 0,
    hasAudio: streams.some((s) => s['codec_type'] === 'audio'),
  };
}

function run(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

export function createFfmpegStitcher(opts: {
  ffmpegExe: string;
  ffprobeExe: string;
  logger: Logger;
  timeoutMs?: number;
}): VideoStitcher {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const probe = async (p: string): Promise<ProbedClip> =>
    parseProbe(await run(opts.ffprobeExe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', p], 60_000));

  return {
    async stitch({ firstPath, secondPath, outputPath }) {
      try {
        const [first, second] = await Promise.all([probe(firstPath), probe(secondPath)]);
        await run(opts.ffmpegExe, buildStitchArgs({ firstPath, secondPath, outputPath, first, second }), timeoutMs);
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error('empty_output');
      } catch (err) {
        try {
          fs.rmSync(outputPath, { force: true });
        } catch {
          // ignore
        }
        // Never log paths or ffmpeg stderr (may contain paths); the error class is enough.
        const e = err as { killed?: boolean; code?: unknown; message?: string };
        const reason = e.killed
          ? 'timeout'
          : typeof e.code === 'number'
            ? `exit_${e.code}`
            : e.message === 'empty_output' || e.message === 'no_video_stream'
              ? e.message
              : 'error';
        opts.logger.error('video_stitch_failed', { reason });
        throw new PodError('VIDEO_STITCH_FAILED');
      }
    },
  };
}

export function createUnavailableStitcher(): VideoStitcher {
  return {
    async stitch() {
      throw new PodError('VIDEO_STITCH_FAILED');
    },
  };
}
