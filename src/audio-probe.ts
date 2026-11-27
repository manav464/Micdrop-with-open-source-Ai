import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

type Probe = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
};

export function probeAudio(
  filePath: string
): Promise<{ durationSeconds: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.FFPROBE_PATH || 'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        filePath,
      ],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Audio inspection timed out.'));
    }, 10_000);
    const finish = (error?: Error, result?: { durationSeconds: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    if (!child.stdout || !child.stderr) {
      child.kill();
      finish(new Error('Could not inspect audio process output.'));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 64_000) {
        child.kill();
        finish(new Error('Audio metadata is too large.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on('error', (error) =>
      finish(
        new Error(
          `Could not start ffprobe. Install FFmpeg or set FFPROBE_PATH. ${error.message}`
        )
      )
    );
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(
          new Error(
            `Invalid or unsupported audio file. ${stderr.slice(0, 300)}`
          )
        );
      try {
        const result = JSON.parse(stdout) as Probe;
        if (!result.streams?.some((stream) => stream.codec_type === 'audio'))
          return finish(new Error('The file contains no audio stream.'));
        const durationSeconds = Number(result.format?.duration);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
          return finish(new Error('Could not determine audio duration.'));
        if (durationSeconds > config.MAX_AUDIO_SECONDS)
          return finish(
            new Error(
              `Audio exceeds the ${config.MAX_AUDIO_SECONDS}-second limit.`
            )
          );
        finish(undefined, { durationSeconds });
      } catch {
        finish(new Error('Audio metadata could not be read.'));
      }
    });
  });
}

export async function normalizeAudio(
  inputPath: string,
  durationSeconds: number
): Promise<string> {
  const outputPath = path.join(
    config.uploadsDir,
    `${randomUUID()}-normalized.wav`
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.env.FFMPEG_PATH || 'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-v',
          'error',
          '-y',
          '-i',
          inputPath,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-sample_fmt',
          's16',
          '-f',
          'wav',
          outputPath,
        ],
        { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let stderr = '';
      let settled = false;
      const timer = setTimeout(
        () => {
          child.kill();
          finish(new Error('Audio conversion timed out.'));
        },
        Math.min(600_000, Math.max(60_000, durationSeconds * 2000))
      );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      if (!child.stderr) {
        child.kill();
        finish(new Error('Could not read audio conversion output.'));
        return;
      }
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.on('error', (error) =>
        finish(
          new Error(
            `Could not start ffmpeg. Install FFmpeg or set FFMPEG_PATH. ${error.message}`
          )
        )
      );
      child.on('close', (code) =>
        code === 0
          ? finish()
          : finish(
              new Error(`Audio conversion failed. ${stderr.slice(0, 300)}`)
            )
      );
    });
    return outputPath;
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function normalizeAndCleanup(
  inputPath: string,
  durationSeconds: number
) {
  try {
    return await normalizeAudio(inputPath, durationSeconds);
  } catch (error) {
    await fs.rm(inputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
