import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { app } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { storage } from './storage.js';
import {
  createSession,
  respondToTurn,
  transcribeFile,
} from './session-service.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256 * 1024,
  handleProtocols: (protocols) =>
    protocols.has('micdrop') ? 'micdrop' : false,
});
const active = new Set<WebSocket>();
const origin = new URL(config.PUBLIC_ORIGIN).origin;

server.on('upgrade', (request, socket, head) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`
  );
  if (url.pathname !== '/api/v1/stream' || request.headers.origin !== origin) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const offeredProtocols = (request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim());
  const wsCredential = `key-${Buffer.from(config.API_KEY).toString('base64url')}`;
  if (
    !offeredProtocols.includes('micdrop') ||
    (config.API_KEY && !offeredProtocols.includes(wsCredential))
  ) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) =>
    wss.emit('connection', ws, request)
  );
});

wss.on('connection', (ws) => {
  active.add(ws);
  let sessionId = '';
  let recording = false;
  let saveRecording = false;
  let recordingPath = '';
  let recordingId = '';
  let recordingHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let recordingBytes = 0;
  let currentTurn = 0;
  let generation = 0;
  let audioBytes = 0;
  let silenceBytes = 0;
  let inSpeech = false;
  let utterancePath = '';
  let utteranceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let utteranceBytes = 0;
  let audioWriteChain = Promise.resolve();
  let queuedAudioBytes = 0;
  const controllers = new Map<number, AbortController>();
  const send = (event: object) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_048_576) {
      ws.close(1013, 'Client is not receiving audio quickly enough');
      return;
    }
    ws.send(JSON.stringify(event));
  };
  const closeFiles = async () => {
    await utteranceHandle?.close().catch(() => undefined);
    utteranceHandle = undefined;
    await recordingHandle?.close().catch(() => undefined);
    recordingHandle = undefined;
  };
  const abortTurns = () => {
    generation++;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  };
  const handleTurn = async (turn: number, wavPath: string) => {
    const controller = new AbortController();
    controllers.set(turn, controller);
    try {
      send({ type: 'transcript.status', turnId: turn, status: 'processing' });
      const transcript = await transcribeFile(
        wavPath,
        'live-utterance.wav',
        sessionId,
        controller.signal
      );
      send({
        type: 'transcript.final',
        turnId: turn,
        text: transcript.text,
        language: transcript.language,
        segments: transcript.segments,
      });
      if (!transcript.text.trim()) {
        send({ type: 'assistant.turn.end', turnId: turn });
        return;
      }
      for await (const event of respondToTurn(
        sessionId,
        transcript.text,
        controller.signal
      )) {
        if (controller.signal.aborted) break;
        if ('audio' in event) send({ ...event, turnId: turn, generation });
        else send({ ...event, turnId: turn, generation });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn({ err: error, sessionId, turn }, 'voice turn failed');
        send({
          type: 'error',
          code: 'TURN_FAILED',
          message:
            'Voice turn failed. Check that the configured ASR, chat, and speech models are reachable.',
        });
      }
    } finally {
      controllers.delete(turn);
      await fs.rm(wavPath, { force: true }).catch(() => undefined);
    }
  };
  const startUtterance = async () => {
    if (inSpeech) return;
    inSpeech = true;
    utteranceBytes = 0;
    silenceBytes = 0;
    currentTurn++;
    utterancePath = path.join(config.uploadsDir, `${randomUUID()}.wav`);
    utteranceHandle = await fs.open(utterancePath, 'w', 0o600);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    await utteranceHandle.write(header);
    send({ type: 'speech.started', turnId: currentTurn });
  };
  const finalizeRecording = async () => {
    if (!recordingHandle || !recordingPath) return undefined;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + recordingBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(recordingBytes, 40);
    await recordingHandle.write(header, 0, header.length, 0);
    await recordingHandle.close();
    recordingHandle = undefined;
    if (recordingBytes > 0) {
      storage.saveRecording({
        id: recordingId,
        sessionId,
        filename: 'micdrop-recording.wav',
        filePath: recordingPath,
      });
      const savedId = recordingId;
      recordingPath = '';
      recordingId = '';
      saveRecording = false;
      return savedId;
    }
    await fs.rm(recordingPath, { force: true });
    recordingPath = '';
    recordingId = '';
    saveRecording = false;
    return undefined;
  };
  const processAudioFrame = async (frame: Buffer) => {
    if (!sessionId) return;
    audioBytes += frame.length;
    if (audioBytes > config.MAX_AUDIO_SECONDS * 32_000) {
      send({
        type: 'error',
        code: 'SESSION_LIMIT',
        message: 'Maximum session audio duration reached.',
      });
      recording = false;
      return;
    }
    if (recordingHandle) {
      await recordingHandle.write(frame);
      recordingBytes += frame.length;
    }
    let energy = 0;
    for (let i = 0; i + 1 < frame.length; i += 2) {
      const sample = frame.readInt16LE(i) / 32768;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / Math.max(1, Math.floor(frame.length / 2)));
    if (rms > 0.018) {
      if (!inSpeech) await startUtterance();
      await utteranceHandle?.write(frame);
      utteranceBytes += frame.length;
      silenceBytes = 0;
    } else if (inSpeech) {
      await utteranceHandle?.write(frame);
      utteranceBytes += frame.length;
      silenceBytes += frame.length;
      if (silenceBytes >= 16_000 * 2 * 0.65) await finishUtterance();
    }
  };
  const finishUtterance = async () => {
    if (!inSpeech || !utteranceHandle) return;
    inSpeech = false;
    const bytes = utteranceBytes;
    await utteranceHandle.close();
    utteranceHandle = undefined;
    const h = await fs.open(utterancePath, 'r+');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + bytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(bytes, 40);
    await h.write(header, 0);
    await h.close();
    const duration = bytes / 32000;
    if (duration >= 0.35 && duration <= config.MAX_AUDIO_SECONDS)
      void handleTurn(currentTurn, utterancePath);
    else await fs.rm(utterancePath, { force: true }).catch(() => undefined);
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!sessionId || !recording) return;
      const frame = Buffer.from(data as Buffer);
      queuedAudioBytes += frame.length;
      if (queuedAudioBytes > 64_000) {
        send({
          type: 'error',
          code: 'AUDIO_BACKPRESSURE',
          message: 'Audio input exceeded the server processing rate.',
        });
        ws.close(1013, 'Audio backpressure');
        return;
      }
      audioWriteChain = audioWriteChain
        .then(() => processAudioFrame(frame))
        .catch((error) => {
          logger.warn({ err: error }, 'audio frame processing failed');
          send({
            type: 'error',
            code: 'AUDIO_WRITE_FAILED',
            message: 'Could not process the audio frame.',
          });
        })
        .finally(() => {
          queuedAudioBytes -= frame.length;
        });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      send({
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Expected a JSON control event.',
      });
      return;
    }
    if (event.type === 'session.start') {
      const session = createSession();
      sessionId = session.id;
      saveRecording = event.saveAudio === true;
      send({
        type: 'session.ready',
        sessionId,
        expiresAt: session.expiresAt,
        format: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 },
      });
      return;
    }
    if (event.type === 'audio.start') {
      if (!sessionId) {
        send({
          type: 'error',
          code: 'SESSION_REQUIRED',
          message: 'Start a session first.',
        });
        return;
      }
      recording = true;
      audioBytes = 0;
      void (async () => {
        if (saveRecording) {
          recordingId = randomUUID();
          recordingPath = path.join(config.recordingsDir, `${recordingId}.wav`);
          recordingBytes = 0;
          recordingHandle = await fs.open(recordingPath, 'w', 0o600);
          const wavHeader = Buffer.alloc(44);
          wavHeader.write('RIFF', 0);
          wavHeader.write('WAVE', 8);
          wavHeader.write('fmt ', 12);
          wavHeader.writeUInt32LE(16, 16);
          wavHeader.writeUInt16LE(1, 20);
          wavHeader.writeUInt16LE(1, 22);
          wavHeader.writeUInt32LE(16000, 24);
          wavHeader.writeUInt32LE(32000, 28);
          wavHeader.writeUInt16LE(2, 32);
          wavHeader.writeUInt16LE(16, 34);
          wavHeader.write('data', 36);
          await recordingHandle.write(wavHeader);
        }
        send({ type: 'audio.ready' });
      })().catch((error) => {
        logger.error({ err: error }, 'could not initialize recording');
        recording = false;
        send({
          type: 'error',
          code: 'RECORDING_FAILED',
          message: 'Could not start audio capture.',
        });
      });
      return;
    }
    if (event.type === 'audio.end') {
      recording = false;
      void (async () => {
        await audioWriteChain;
        await finishUtterance();
        const saved = await finalizeRecording();
        await closeFiles();
        send({ type: 'audio.ended', recordingId: saved });
      })();
      return;
    }
    if (event.type === 'interrupt') {
      abortTurns();
      send({ type: 'turn.interrupted', generation });
      return;
    }
    if (event.type === 'session.end') {
      recording = false;
      abortTurns();
      storage.endSession(sessionId);
      void (async () => {
        await audioWriteChain;
        await finishUtterance();
        const saved = await finalizeRecording();
        await closeFiles();
        send({ type: 'session.ended', recordingId: saved });
      })();
      return;
    }
    if (event.type === 'ping') send({ type: 'pong', at: Date.now() });
  });
  ws.on('close', () => {
    active.delete(ws);
    abortTurns();
    void audioWriteChain.then(async () => {
      await closeFiles();
      if (recordingPath)
        await fs.rm(recordingPath, { force: true }).catch(() => undefined);
    });
  });
  ws.on('error', (error) => logger.warn({ err: error }, 'websocket error'));
});

server.listen(config.PORT, config.HOST, () =>
  logger.info(
    { host: config.HOST, port: config.PORT },
    'Micdrop audio AI server started'
  )
);

const shutdown = () => {
  logger.info('shutting down');
  for (const socket of active) socket.close(1001, 'Server shutting down');
  wss.close();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
