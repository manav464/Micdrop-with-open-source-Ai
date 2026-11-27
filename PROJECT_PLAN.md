# Project Plan: Open-Source Audio AI with Express.js

**Research snapshot: 27 November 2026.** This plan separates the Express.js product backend from optional Python/Rust inference runtimes. Repository and model capabilities change quickly; pin exact revisions, weights, licenses, and runtime versions before deployment. This is technical planning, not legal advice.

## Executive recommendation

Build a TypeScript Express.js application, with `ws` for WebSocket transport and model-provider interfaces. Start with a turn-based voice assistant: browser `getUserMedia`/AudioWorklet capture → WebSocket audio frames → VAD/turn detection → streaming ASR → local/open-weight LLM → chunked TTS playback. Use Micdrop (`Godefroy/micdrop`) as an optional client/session SDK after a short compatibility spike; it is a real MIT-licensed Node/browser SDK, not a model or inference engine. Keep a first-party provider boundary so the app is not coupled to its abstractions.

For the MVP, prioritize offline transcription with faster-whisper (large-v3 or a smaller quantized variant according to hardware), and conversational partials with a genuinely streaming ASR such as Vosk or a currently verified NeMo streaming checkpoint. Use Kokoro for a compact preset-voice TTS path. A local text LLM can be served through an OpenAI-compatible local endpoint. Keep direct speech-to-speech as an experimental adapter: Qwen2.5-Omni has real audio input and streaming speech output, while Kyutai Moshi is explicitly full-duplex; neither should be presented as a low-resource drop-in without benchmarking and license review.

## Scope and decisions

- Backend, orchestration, sessions, validation, storage, and APIs are Express.js/Node.js. Python is permitted only behind a local inference service where the maintained model ecosystem requires it.
- Use TypeScript, strict schemas, Node.js LTS, Express 5 (pin/verify release), `ws`, structured logs, and a provider-neutral domain layer.
- Start with local filesystem temporary audio and SQLite for a single-user prototype. PostgreSQL and Redis are later additions for multi-instance persistence/coordination, not MVP requirements.
- Do not retain audio/transcripts by default. Make persistence explicit and configurable.
- Treat “open source” as two checks: code license and each model/voice/weight license. Open weights do not automatically mean OSI open source or unrestricted commercial use.

## Model and technology research

See [MODEL_COMPARISON.md](MODEL_COMPARISON.md) for task-by-task comparison, source links, licenses, and uncertainty. Headline conclusions:

| Need                                 | Initial recommendation                                                             | Reason / caveat                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High quality offline ASR             | faster-whisper with Whisper large-v3; benchmark distil-large-v3 and small/medium   | Mature multilingual transcription, timestamps and language detection; not native low-latency streaming and needs CPU/GPU budget.                                               |
| Low latency incremental ASR          | Vosk for compact CPU baseline; evaluate a current NeMo streaming model for quality | Native streaming architecture matters; Vosk quality varies by language/model. NeMo deployments are more complex and often GPU-oriented.                                        |
| Mainstream voice output              | Kokoro-82M                                                                         | Lightweight, Apache-licensed weights, fast and good preset voices; no arbitrary voice cloning, language/runtime frontend varies.                                               |
| Direct audio conversation experiment | Qwen2.5-Omni first, Moshi full-duplex comparison                                   | Qwen supports audio understanding and streaming generated speech; Moshi was designed for simultaneous listen/speak, but model/runtime and license/hardware constraints matter. |
| VAD                                  | browser-side Silero VAD or volume baseline; server validates turn boundaries       | VAD is not diarization or semantic turn detection. Use hysteresis and hangover.                                                                                                |
| Audio conversion                     | FFmpeg subprocess with fixed executable/arguments and bounded resources            | Broad codecs; build configuration affects license. Never interpolate user input into shell commands.                                                                           |

## Micdrop assessment

The brief's “MicDrop” is ambiguous by name alone. Research identified [Godefroy/micdrop](https://github.com/Godefroy/micdrop) and [micdrop.dev](https://micdrop.dev/): a TypeScript, MIT-licensed SDK with browser/React Native capture, VAD, WebSocket conversation transport, playback, turn taking, interruption/echo handling, reconnection, and server orchestration. It advertises plain `ws`, Fastify, and NestJS compatibility, so Express integration is plausible through a shared WebSocket server; verify exact package versions, Node/browser support, persistence hooks, and local-provider adapters in a spike. It is not itself Express middleware, a codec/transcoder, or a model. Its provider catalog includes hosted APIs and selected local wrappers; do not infer that every integration is local or commercial-safe. If the intended MicDrop was another product/package, this finding does not identify it.

Browser responsibilities: permission, capture, AudioWorklet framing/resampling where required, local VAD/UI, playback queue, interruption signal. Server responsibilities: auth/origin checks, bounded binary frame protocol, authoritative session state, optional VAD, provider orchestration, rate/resource limits, persistence and cleanup. [Micdrop browser docs](https://micdrop.dev/docs/client) describe its client scope.

## Architecture overview

```text
Browser UI + AudioWorklet
  ├─ HTTPS REST: session lifecycle, uploads, transcripts
  └─ WSS: audio frames, partial/final text, response audio, cancel/errors
           │
Express app ─ auth/validation/rate limits ─ session manager ─ ws gateway
           │                                           │
     upload/transcript API                     Audio pipeline
                                                   ├─ decode/resample + VAD
                                                   ├─ ASRProvider
                                                   ├─ ConversationProvider
                                                   ├─ TTSProvider
                                                   └─ SpeechToSpeechProvider (optional)
           │
     temporary disk / SQLite → later PostgreSQL/object storage
           │
      local inference adapters (Node native/ONNX or Python sidecar)
```

Interfaces and protocol details are in [ARCHITECTURE.md](ARCHITECTURE.md). Keep adapters stateless where possible; session/conversation state belongs to the application service. Assign monotonically increasing turn/sequence IDs, propagate `AbortSignal` to model calls, and reject stale output after interruption.

## Hardware and deployment baseline (planning estimates)

These are sizing envelopes, not vendor benchmark guarantees; actual throughput depends on model quantization, concurrency, context length, CPU/GPU generation, and audio format. Measure real-time factor (RTF), first partial, time-to-first-audio, and concurrent sessions on target hardware.

| Tier                   | Practical starting point                                          | Use                                                                                             |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| CPU-only development   | 6–8 modern cores, 16 GB RAM, 30–60 GB free disk                   | API, VAD, small ASR/TTS, one session; large ASR and LLM may be slow.                            |
| Recommended local GPU  | 8–16 CPU cores, 32 GB RAM, NVIDIA GPU 12–16 GB VRAM, 100 GB SSD   | Quantized 7B text model plus modest ASR/TTS; avoid loading several large models simultaneously. |
| High-performance local | 16+ cores, 64 GB RAM, 24–48 GB VRAM, 200+ GB NVMe                 | Larger ASR/LLM, multiple concurrent streams, direct audio experiments.                          |
| Small CPU server       | 8 vCPU, 16–32 GB RAM, SSD; external/local model host              | API and one or few modest inference workloads. Scale inference separately.                      |
| GPU production node    | 16+ vCPU, 64 GB RAM, 24+ GB VRAM per worker as benchmark dictates | Separate API from GPU workers; queue admission and concurrency cap.                             |

Whisper weights span roughly tens of MB (tiny) through multiple GB (large); Qwen2.5-Omni 7B and Moshi-class models have multi-GB weights and practical VRAM needs beyond raw quantized weight size. Budget additional disk for caches, converted models, logs, and temporary recordings. Windows is fine for Express/client development; Linux is the recommended model-serving/container target. WSL2 is a workable Windows GPU development path but adds device/runtime friction. Verify CUDA, driver, ONNX, and container support for the pinned inference runtime.

## MVP recommendation

1. One browser client, one authenticated session, mono 16 kHz PCM frames (or a supported browser codec with server-side decode), WSS, explicit start/stop, and turn-based operation.
2. VAD and incremental transcript events; do not promise full-duplex until interruption and echo behavior are validated.
3. Local ASR adapter, local LLM endpoint, Kokoro TTS adapter. Provide a text-only fallback and visible model-health state.
4. Upload transcription endpoint with FFmpeg normalization, language detection, timestamps, optional diarization deferred.
5. No persistent raw audio by default; opt-in recording with retention policy and delete endpoint.
6. Benchmark CPU-only and one GPU target before selecting default model sizes. Direct speech-to-speech remains a feature-flagged experiment.

## Risks / decisions to resolve during implementation

- Model weights may carry terms different from their repository code; audit every exact checkpoint and voice.
- ASR hallucination, accent/noise/domain error, and language identification need confidence-aware UX; never treat transcript as ground truth in high-stakes use.
- Browser codec/sample-rate mismatch, WebSocket buffering, GPU contention, and model cold starts dominate latency.
- Full-duplex speech can produce self-interruption/echo and stale audio; cancellation must stop both playback and server generation.
- Audio is sensitive personal data. Consent, retention, deletion, encryption, access control, and jurisdiction-specific privacy obligations need product decisions.
- Model servers are a resource-exhaustion boundary; isolate them, cap concurrency and duration, and avoid loading untrusted serialized model artifacts.
- “Open source” claims must distinguish source-available/open-weight and permissive from noncommercial/research-only licenses.

## Roadmap

See [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) for phases, dependencies, risks, acceptance criteria, and complexity. No application code is part of this planning deliverable.

## Primary source index

- [OpenAI Whisper](https://github.com/openai/whisper), [model card](https://github.com/openai/whisper/blob/main/model-card.md), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [NVIDIA NeMo Speech](https://github.com/NVIDIA-NeMo/Speech), [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp), [Vosk API](https://github.com/alphacep/vosk-api)
- [Qwen2.5-Omni](https://github.com/QwenLM/Qwen2.5-Omni), [Kyutai Moshi](https://github.com/kyutai-labs/moshi)
- [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M), [Piper](https://github.com/rhasspy/piper), [Coqui XTTS license](https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt)
- [Silero VAD](https://github.com/snakers4/silero-vad), [FFmpeg license](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md), [Micdrop](https://github.com/Godefroy/micdrop)
