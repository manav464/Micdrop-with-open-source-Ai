import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { cleanupExpiredSessions, storage } from './storage.js';
import { createSession, transcribeFile } from './session-service.js';
import { providerStatus } from './providers.js';
import { normalizeAndCleanup, probeAudio } from './audio-probe.js';

export const app = express();
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader(
    'X-Request-Id',
    req.header('x-request-id')?.slice(0, 100) || randomUUID()
  );
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && config.API_KEY) {
    const supplied =
      req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const a = Buffer.from(supplied),
      b = Buffer.from(config.API_KEY);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return res
        .status(401)
        .json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Valid API credentials are required.',
          },
        });
  }
  next();
});
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const upload = multer({
  dest: config.uploadsDir,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/webm',
      'audio/ogg',
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/aac',
      'audio/flac',
      'application/octet-stream',
    ]);
    if (!allowed.has(file.mimetype))
      return cb(new Error('Unsupported audio content type'));
    cb(null, true);
  },
});

app.get('/api/v1/health', (_req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);
app.get('/api/v1/ready', (_req, res) =>
  res.json({ status: storage.isReady() ? 'ready' : 'not-ready' })
);
app.get('/api/v1/models', async (_req, res, next) => {
  try {
    res.json({ providers: await providerStatus() });
  } catch (e) {
    next(e);
  }
});

app.post('/api/v1/sessions', (_req, res) => {
  const session = createSession();
  res
    .status(201)
    .json({
      sessionId: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      formats: [{ codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }],
    });
});
app.get('/api/v1/sessions/:id', (req, res) => {
  const session = storage.getSession(req.params.id);
  if (!session || session.endedAt || Date.parse(session.expiresAt) < Date.now())
    return res
      .status(404)
      .json({
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found or expired.',
        },
      });
  res.json({ ...session, history: undefined });
});
app.delete('/api/v1/sessions/:id', (req, res) => {
  storage.endSession(req.params.id);
  res.status(204).end();
});

app.post(
  '/api/v1/transcriptions',
  upload.single('file'),
  async (req, res, next) => {
    const file = req.file;
    if (!file)
      return res
        .status(400)
        .json({
          error: {
            code: 'FILE_REQUIRED',
            message: 'Attach one audio file using the file field.',
          },
        });
    let normalizedPath: string | undefined;
    try {
      const fs = await import('node:fs/promises');
      const header = Buffer.alloc(16);
      const handle = await fs.open(file.path, 'r');
      await handle.read(header, 0, header.length, 0);
      await handle.close();
      const validAudio =
        (header.toString('ascii', 0, 4) === 'RIFF' &&
          header.toString('ascii', 8, 12) === 'WAVE') ||
        header.toString('ascii', 0, 4) === 'fLaC' ||
        header.toString('ascii', 0, 4) === 'OggS' ||
        header.toString('ascii', 0, 4) === 'FORM' ||
        header.toString('ascii', 4, 8) === 'ftyp' ||
        header.toString('ascii', 0, 3) === 'ID3' ||
        (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) ||
        (header[0] === 0x1a &&
          header[1] === 0x45 &&
          header[2] === 0xdf &&
          header[3] === 0xa3);
      if (!validAudio)
        return res
          .status(415)
          .json({
            error: {
              code: 'INVALID_AUDIO',
              message:
                'The uploaded file does not look like a supported audio format.',
            },
          });
      const metadata = await probeAudio(file.path);
      normalizedPath = await normalizeAndCleanup(
        file.path,
        metadata.durationSeconds
      );
      const result = await transcribeFile(
        normalizedPath,
        `${path.parse(file.originalname).name}.wav`,
        typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined
      );
      if (req.body.persist === 'true' && !result.persisted) {
        storage.saveTranscript({
          id: result.id,
          sessionId:
            typeof req.body.sessionId === 'string'
              ? req.body.sessionId
              : undefined,
          filename: path.basename(file.originalname),
          transcript: result.text,
          language: result.language,
          segments: result.segments,
        });
        result.persisted = true;
      }
      res
        .status(201)
        .json({ ...result, durationSeconds: metadata.durationSeconds });
    } catch (error) {
      next(error);
    } finally {
      const fs = await import('node:fs/promises');
      await fs.rm(file.path, { force: true }).catch(() => undefined);
      if (normalizedPath)
        await fs.rm(normalizedPath, { force: true }).catch(() => undefined);
    }
  }
);
app.get('/api/v1/transcriptions/:id', (req, res) => {
  const item = storage.getTranscript(req.params.id);
  if (!item)
    return res
      .status(404)
      .json({
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found.',
        },
      });
  res.json(item);
});
app.get('/api/v1/transcriptions/:id/export', (req, res) => {
  const item = storage.getTranscript(req.params.id);
  if (!item)
    return res
      .status(404)
      .json({
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found.',
        },
      });
  const format = req.query.format ?? 'txt';
  if (format === 'json') return res.json(item);
  if (format === 'vtt') {
    const stamp = (n = 0) => {
      const ms = Math.max(0, Math.round(n * 1000));
      return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    };
    const body = `WEBVTT\n\n${(item.segments as Array<{ start?: number; end?: number; text: string }>).map((s) => `${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}`).join('\n\n')}`;
    res.type('text/vtt').attachment('transcript.vtt').send(body);
    return;
  }
  if (format !== 'txt')
    return res
      .status(400)
      .json({
        error: {
          code: 'INVALID_FORMAT',
          message: 'Supported formats: txt, json, vtt.',
        },
      });
  res.type('text/plain').attachment('transcript.txt').send(item.transcript);
});
app.get('/api/v1/recordings/:id', (req, res) => {
  const item = storage.getRecording(req.params.id);
  if (
    !item ||
    path.dirname(path.resolve(item.filePath)) !== config.recordingsDir
  )
    return res
      .status(404)
      .json({
        error: { code: 'RECORDING_NOT_FOUND', message: 'Recording not found.' },
      });
  res.type('audio/wav').download(item.filePath, `micdrop-${item.id}.wav`);
});
app.delete('/api/v1/recordings/:id', async (req, res, next) => {
  const item = storage.deleteRecording(req.params.id);
  if (!item)
    return res
      .status(404)
      .json({
        error: { code: 'RECORDING_NOT_FOUND', message: 'Recording not found.' },
      });
  try {
    await (await import('node:fs/promises')).rm(item.filePath, { force: true });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
app.delete('/api/v1/transcriptions/:id', (req, res) => {
  if (!storage.deleteTranscript(req.params.id))
    return res
      .status(404)
      .json({
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: 'Transcript not found.',
        },
      });
  res.status(204).end();
});

app.post('/api/v1/tts', async (req, res, next) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 4000)
    return res
      .status(400)
      .json({
        error: {
          code: 'INVALID_TEXT',
          message: 'Text must contain 1–4000 characters.',
        },
      });
  try {
    const { ttsProvider } = await import('./providers.js');
    const audio = await ttsProvider.synthesize(text);
    res.type('audio/wav').send(Buffer.from(audio));
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.resolve('public'), { extensions: ['html'] }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = error as Error & { code?: string };
  logger.error({ err: e }, 'request failed');
  const status =
    e instanceof multer.MulterError
      ? e.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400
      : e.message === 'Unsupported audio content type'
        ? 415
        : /exceeds the .*second limit|metadata is too large/i.test(e.message)
          ? 413
          : /invalid or unsupported audio|contains no audio|determine audio duration|audio metadata could not|audio conversion failed/i.test(
                e.message
              )
            ? 400
            : /could not start ffprobe|could not start ffmpeg/i.test(e.message)
              ? 503
              : 502;
  const message =
    status === 502
      ? 'The request could not be completed. Check the configured inference service.'
      : status === 503
        ? 'Audio tools are unavailable. Install FFmpeg or configure its executable paths.'
        : e.message;
  res
    .status(status)
    .json({ error: { code: e.code ?? 'REQUEST_FAILED', message } });
});

setInterval(cleanupExpiredSessions, 60_000).unref();
