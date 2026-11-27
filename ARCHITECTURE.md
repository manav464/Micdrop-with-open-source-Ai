# Express.js Audio AI Architecture

## Goals and boundaries

The product server is pure Node.js/Express.js. Python or native inference processes are optional, isolated model workers reached through local HTTP/gRPC/stdio adapters; they do not own sessions, auth, API policy, recordings, or business logic. Keep browser capture/playback separate from backend model orchestration. Make every model swappable through typed contracts.

## Component map

```text
Browser (UI, getUserMedia, AudioWorklet, playback queue)
  ├─ REST /api/v1 (session, upload, transcript, TTS, status)
  └─ WSS /api/v1/stream (audio + control/event frames)
          │
Express 5 app ─ request ID, auth, schema validation, limits, logs
          ├─ controllers → application services → session/conversation store
          ├─ upload service → temp store → decode/resample → ASR provider
          └─ WebSocket gateway → audio pipeline
                 ├─ optional AudioProcessingProvider / VADProvider
                 ├─ ASRProvider → ConversationProvider → TTSProvider
                 └─ SpeechToSpeechProvider (feature-flagged)
                          │
              in-process Node/ONNX or local Python/native model workers
```

## Provider contracts (conceptual TypeScript)

```ts
type AudioFormat = {
  codec: string;
  sampleRate: number;
  channels: number;
  encoding?: string;
};
type AudioChunk = {
  sessionId: string;
  turnId: number;
  seq: number;
  format: AudioFormat;
  data: Uint8Array;
  final?: boolean;
};
type Transcript = {
  text: string;
  startMs?: number;
  endMs?: number;
  speaker?: string;
  final: boolean;
  language?: string;
  confidence?: number;
};

interface ASRProvider {
  transcribeFile(input: {
    path: string;
    format?: AudioFormat;
    signal?: AbortSignal;
  }): Promise<{ segments: Transcript[]; language?: string }>;
  stream?(
    input: AsyncIterable<AudioChunk>,
    signal: AbortSignal
  ): AsyncIterable<Transcript>;
}
interface ConversationProvider {
  respond(input: {
    sessionId: string;
    messages: Array<{ role: string; content: string }>;
    signal: AbortSignal;
  }): AsyncIterable<{ textDelta: string; done?: boolean }>;
}
interface TTSProvider {
  synthesize(input: {
    text: string;
    voice?: string;
    signal: AbortSignal;
  }): AsyncIterable<{ data: Uint8Array; format: AudioFormat; seq: number }>;
}
interface SpeechToSpeechProvider {
  converse(
    input: AsyncIterable<AudioChunk>,
    context: unknown,
    signal: AbortSignal
  ): AsyncIterable<{
    text?: Transcript;
    audio?: Uint8Array;
    format?: AudioFormat;
    seq: number;
  }>;
}
interface VADProvider {
  detect(frame: AudioChunk): Promise<{ speech: boolean; score?: number }>;
}
interface AudioProcessingProvider {
  normalize(
    input: AsyncIterable<AudioChunk>,
    target: AudioFormat,
    signal: AbortSignal
  ): AsyncIterable<AudioChunk>;
  decodeFile(
    path: string,
    target: AudioFormat,
    signal: AbortSignal
  ): Promise<string>;
}
```

These are design contracts, not implementation code. Standardize stream cancellation, timeout, error categories, format negotiation, and provider health. An adapter must report supported languages/formats/streaming and resource cost through metadata rather than assuming all providers behave alike.

## Responsibilities and folder proposal

```text
src/
  app.ts                    Express construction; no listen side effects
  server.ts                 HTTP server, WebSocket attachment, graceful shutdown
  config/                   validated environment schema and defaults
  api/v1/routes/            route declarations
  api/v1/controllers/       HTTP request/response mapping
  api/v1/schemas/           request and WebSocket schema definitions
  middleware/               auth, rate limits, request ID, errors, upload limits
  websocket/                handshake, protocol parser, queues, heartbeat
  sessions/                 lifecycle, quotas, expiry, abort handling
  conversations/            context policy, turn state, transcript events
  audio/                     formats, conversion wrapper, chunk clock/metadata
  providers/interfaces/     provider contracts and capabilities
  providers/asr/            faster-whisper/Vosk/NeMo adapters
  providers/tts/            Kokoro/Piper adapters
  providers/llm/            OpenAI-compatible local endpoint adapter
  providers/speech/         Qwen/Moshi experimental adapters
  services/                 transcription, voice turn, upload, export
  storage/                   temp files, SQLite repository, retention jobs
  observability/             structured logger, metrics, tracing hooks
  shared/                    errors, IDs, constants
```

Node owns `/api/v1` routes, auth, validation, upload policy, session state, WebSocket transport, conversation context, model selection, cancellation, storage, logs, health/readiness, and cleanup. A Python inference worker owns only model load/inference and converts provider-specific results to its adapter protocol. Do not let the worker expose arbitrary filesystem paths or accept shell/model path input from clients.

## Runtime strategies

1. **ASR → LLM → TTS (MVP).** Best observability, transcript access, component substitution, and practical moderate-hardware deployment. Cost is serial latency; reduce it with streaming ASR/LLM/TTS and early response chunks.
2. **Audio understanding → response → TTS.** Use for audio-centric intent/context, but disclose if transcripts are absent and verify the model's actual task. Keep transcript fallback for accessibility/debugging.
3. **Direct speech-to-speech.** Use Qwen2.5-Omni/Moshi experiments when audio quality and low latency matter enough to justify higher compute and reduced step-level inspectability. Treat support for user barge-in as independently tested.

## Session and audio workflow

1. Client obtains microphone permission on an explicit user gesture. Capture mono frames through AudioWorklet. Negotiate codec/sample rate when opening the session; send bounded frames with `sessionId`, `turnId`, `seq`, and client timestamp.
2. `POST /sessions` creates an opaque, expiring session after auth/quota checks. WSS handshake binds the authorized session and checks origin/token. No user-supplied path is accepted.
3. Receive frames into a bounded per-session queue. Validate message size, sequence, sample rate and duration. If queue high-water mark is reached, apply protocol-level pause/drop policy and emit backpressure; never buffer without limit.
4. Optional VAD emits speech start/end candidates with hangover and minimum speech duration. Separate VAD from semantic end-of-turn. Stream to ASR for interim results or accumulate utterance to an offline model.
5. On final user turn, add transcript to bounded conversation context. Start LLM stream. As complete clauses become safe to speak, feed TTS. Preserve chunk order and a response generation ID.
6. Client schedules audio chunks, reports playback state, and sends `interrupt`. Server aborts ASR/LLM/TTS operations, marks generation ID stale, drains outbound queue; client immediately flushes playback. Late provider chunks are discarded.
7. Session end or disconnect triggers configurable grace period, aborts jobs, closes files, and deletes ephemeral state. Persist only with explicit policy/consent.

For full-duplex models, input continues while assistant output plays. Echo cancellation/reference handling and barge-in detection must avoid feeding the assistant's own voice back as user speech. This behavior requires device-level tests.

## WebSocket protocol proposal

Use WSS and JSON text control events plus binary audio frames. A binary frame is associated with the current negotiated session/turn and carries sequence metadata in a small fixed header or paired envelope; avoid JSON/base64 audio for throughput. Version the protocol.

Client → server events: `hello` (protocol version, session token, formats), `audio.start`, binary `audio.chunk`, `audio.end`, `interrupt`, `ping`, `session.end`.

Server → client events: `ready` (negotiated format), `speech.started`, `transcript.partial`, `transcript.final`, `assistant.text.delta`, `assistant.audio.start`, binary ordered audio chunks, `assistant.audio.end`, `turn.interrupted`, `backpressure`, `error`, `pong`, `session.ended`.

Every event includes `sessionId`, relevant `turnId`, sequence, and generation ID. Client ignores older generations. Errors have stable code, retryable boolean, and safe message; never expose internal paths/stack traces. Limit text/control payloads, binary frame duration, total session duration, and concurrent sessions.

## HTTP API sketch

| Method / path                                     | Purpose                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /api/v1/sessions`                           | Start session; returns session ID, expiring stream credential, supported formats. |
| `DELETE /api/v1/sessions/:id`                     | End session, cancel work, apply retention policy.                                 |
| `GET /api/v1/sessions/:id`                        | Retrieve authorized session state.                                                |
| `POST /api/v1/transcriptions`                     | Multipart/streaming upload; returns job or transcript. Enforce duration/size.     |
| `GET /api/v1/transcriptions/:id`                  | Transcript and segments.                                                          |
| `GET /api/v1/transcriptions/:id/export?format=vtt | srt                                                                               | json | txt` | Download transcript with safe content disposition. |
| `POST /api/v1/tts`                                | Text plus voice ID; respond with audio stream or job ID.                          |
| `POST /api/v1/audio-conversations`                | Optional non-live file-based audio understanding/speech response.                 |
| `GET /api/v1/health`                              | Process liveness only.                                                            |
| `GET /api/v1/ready`                               | Required dependencies and configured adapter readiness.                           |
| `GET /api/v1/models`                              | Sanitized model names, capabilities and health; admin/auth protected.             |

Example create response: `{"sessionId":"opaque-id","streamUrl":"wss://host/api/v1/stream","streamToken":"short-lived-token","expiresAt":"...","formats":[{"codec":"pcm_s16le","sampleRate":16000,"channels":1}]}`. Do not use a long-lived bearer token in a URL/log.

## Transcription pipeline

Accept only allowlisted MIME hints plus content inspection; MIME alone is untrusted. Stream uploads to a random private temp path with a strict byte limit. Probe with FFmpeg in an isolated worker under duration/CPU/memory limits, reject malformed/oversized streams, normalize to provider sample rate/channel count, then transcribe. Record source offsets for chunks. Return interim/final separately; final contains detected language, segment timestamps and optional confidence. Diarization is opt-in and provider capability-specific. Delete temp files in `finally`, including failures/disconnects. Export TXT/JSON/VTT/SRT with sanitized filenames.

## Storage, reliability, operations

MVP: SQLite for metadata/session records when persistence is needed; local private temp directory for in-flight audio. Use random server-side IDs and access checks. Production: PostgreSQL for durable metadata, object storage for opt-in recordings, encryption at rest, retention job, per-record authorization, audit event without raw content. Redis only if multi-instance ephemeral session coordination, distributed limits, or job queues become necessary.

Use pino-style structured logs with request/session IDs but no raw audio, transcript text, credentials, or provider payloads by default. Track queue depth, dropped frames, VAD duration, ASR real-time factor, LLM first-token, TTS first-byte, turn latency, cancellations, failures, GPU utilization and model cold starts. Readiness should distinguish process alive from model ready. Use graceful shutdown to reject new sessions, abort work, then close sockets and stores.

## Security and reliability controls

- Authenticated/short-lived session credentials, WebSocket origin allowlist, TLS, per-user quotas and rate limits.
- File allowlist, byte/duration/channel/sample-rate caps, random filenames, private storage, no path traversal, malware/decoder isolation where threat model warrants.
- Invoke FFmpeg with `spawn(executable, fixedArgs)` and validated values; never compose a shell command from filenames/user values.
- Bound queues, provider concurrency, inference duration, output size, context token count, and idle session lifetime.
- Handle disconnect, timeout, provider restart, model OOM, partial upload, duplicate sequence, and cancellation idempotently.
- Keep secrets in environment/secret manager; redact. Do not load serialized model artifacts supplied by users.
- Explicit recording consent, retention period, deletion workflow, access-control audit and encryption for persistent sensitive data.

## Stack decisions

Node.js LTS + TypeScript + Express.js; `ws`; schema validation (Zod/Valibot/Ajv, choose one); structured logger; Multer only for modest bounded multipart uploads, otherwise streaming Busboy/raw request streams; FFmpeg as separately installed/pinned binary; SQLite for prototype, PostgreSQL only with durable/multi-user need; Docker Compose for local app plus optional inference workers. Use Helmet, CORS with exact origins, and rate-limit middleware. Avoid Redis, Socket.IO, and a database until the product's scale/persistence needs justify them.
