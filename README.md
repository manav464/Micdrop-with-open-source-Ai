# Micdrop Audio AI

A local-first voice assistant built with Express.js, TypeScript, WebSocket, and a browser microphone client. The app owns sessions, audio transport, conversation history, upload validation, storage, and orchestration. ASR, chat, and speech generation are replaceable external local inference services that expose OpenAI-compatible APIs; model weights are not bundled.

## Requirements

- Node.js 20 or newer
- FFmpeg tools (`ffprobe` and `ffmpeg` on `PATH`, or configure `FFPROBE_PATH`/`FFMPEG_PATH`) for upload validation and normalization
- A local chat server with `POST /v1/chat/completions` streaming support (for example, Ollama's OpenAI-compatible endpoint)
- An ASR server with `POST /v1/audio/transcriptions` and `verbose_json` support
- A TTS server with `POST /v1/audio/speech` returning WAV data

The ASR and TTS endpoints are not provided by Ollama. Install local servers and model weights separately, then review their exact model and voice licenses. The app defaults point to common local ports as examples; change them to the endpoints you actually run.

## Start

```sh
npm install
# PowerShell: Copy-Item .env.example .env
# macOS/Linux: cp .env.example .env
# Edit .env to match your model servers and model names.
npm run dev
```

Open `http://localhost:3000` in a modern browser. Press **Start talking** to grant microphone access. Speech is framed as mono 16 kHz PCM over WebSocket; a server-side energy VAD closes a turn after about 650 ms of silence. The turn is transcribed, sent to the streaming chat endpoint, then spoken in sentence-sized WAV chunks. Tap the listening button to cancel the current model generation and stop playback. Microphone recording is off by default; enable **Save microphone audio** before starting to keep and download a WAV recording. The transcript upload tool has its own opt-in save checkbox.

Build and run the compiled server:

```sh
npm run build
npm start
```

By default the server binds to `127.0.0.1`, accepts connections from `http://localhost:3000`, and stores SQLite metadata and short-lived audio scratch files in `./data`. Set `HOST=0.0.0.0` only behind a trusted network boundary. For a shared deployment set a long random `API_KEY`, configure HTTPS/WSS at a reverse proxy, and set `PUBLIC_ORIGIN` to the browser origin. The UI prompts for the API key when needed and keeps it in the current browser tab's session storage.

## Configure inference

| Variable               | Expected endpoint                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ASR_BASE_URL`         | OpenAI-compatible base, app calls `/audio/transcriptions` with multipart file, model and `verbose_json` response format. |
| `LLM_BASE_URL`         | OpenAI-compatible base, app calls `/chat/completions` with SSE streaming.                                                |
| `TTS_BASE_URL`         | OpenAI-compatible base, app calls `/audio/speech` with `model`, `voice`, `input`, and `response_format: wav`.            |
| `*_MODEL`, `TTS_VOICE` | Model/voice identifiers configured in those inference servers.                                                           |

All model endpoints should bind to loopback when they run on the same machine. Configure explicit request limits at any reverse proxy. The app does not download weights or execute shell commands.

## API

- `GET /api/v1/health` — process liveness
- `GET /api/v1/ready` — storage readiness
- `GET /api/v1/models` — ASR/LLM/TTS endpoint reachability
- `POST /api/v1/sessions`, `GET /api/v1/sessions/:id`, `DELETE /api/v1/sessions/:id`
- `POST /api/v1/transcriptions` — multipart field `file`; supports recognized WAV, WebM, MP3, MP4/M4A, OGG and FLAC signatures up to `MAX_UPLOAD_MB`. Add form field `persist=true` to save the transcript for retrieval/export.
- `GET /api/v1/transcriptions/:id` — stored transcript metadata and segments
- `GET /api/v1/transcriptions/:id/export?format=txt|json|vtt`
- `DELETE /api/v1/transcriptions/:id` — delete saved transcript
- `GET /api/v1/recordings/:id`, `DELETE /api/v1/recordings/:id` — download/delete an opted-in microphone WAV
- `POST /api/v1/tts` — JSON `{ "text": "..." }`, returns WAV
- `WS /api/v1/stream` — control events are JSON; audio frames are binary PCM16 mono 16 kHz

The live WebSocket emits `session.ready`, `audio.ready`, `speech.started`, `transcript.status`, `transcript.final`, `assistant.text.delta`, `assistant.audio`, `assistant.turn.end`, and `turn.interrupted`. ASR runs when the VAD closes an utterance; live interim ASR partials and full-duplex speech-to-speech are not implemented in this first release. Model boundaries are provider-compatible HTTP APIs so the ASR/LLM/TTS choices can be changed without changing session orchestration.

## Data and security

SQLite stores session metadata and explicitly saved transcripts/recording metadata. Conversation context is held only in process memory and is discarded when the session ends or expires. Uploaded files and live utterance WAVs are temporary and deleted after processing. Microphone recording and uploaded transcript persistence are off by default; use the UI checkboxes or set `STORE_TRANSCRIPTS=true` to save uploads. Opted-in recordings stay under `data/recordings` until deleted with the API or by removing the data directory. Protect the data directory. `API_KEY` is optional for loopback-only development and should be configured outside localhost. Never expose inference endpoints directly to an untrusted network. Logs omit audio and transcript content.

The basic VAD threshold is energy-based and may need tuning for microphones/noise. Upload signature checks are a first filter; keep inference services patched and resource-limited. There is no production authentication/user tenancy, encrypted transcript database, streaming interim ASR, diarization, distributed queue, or direct speech-to-speech adapter in this first release.

## Development

```sh
npm run typecheck
npm run build
```

Planning references: [project plan](PROJECT_PLAN.md), [model comparison](MODEL_COMPARISON.md), [architecture](ARCHITECTURE.md), and [implementation roadmap](IMPLEMENTATION_ROADMAP.md).
