# Implementation Roadmap

Complexity estimates are relative to a small experienced team: **S** up to several days, **M** roughly 1–2 weeks, **L** multiple weeks. Re-estimate after the first hardware and integration spike. This document plans future work; no app code is requested or included now.

## Phase 1 — Research and architecture (M)

**Tasks:** Confirm intended Micdrop repo/package; pin candidate model revisions; sample representative languages/noise; benchmark faster-whisper, one streaming ASR, Kokoro, local LLM, and optionally Qwen/Moshi; build a license inventory covering code, weights, voices, codecs and model outputs; record CPU/GPU measurements.

**Decisions/dependencies:** Choose TypeScript, Node LTS, Express version, audio protocol, sample format, target hardware, retention defaults. Depends on hardware/audio samples and license review.

**Risks:** benchmark claims won't transfer to user hardware; checkpoint license may differ from code; model ecosystem changes rapidly.

**Acceptance:** signed-off architecture; compatibility proof for Micdrop + Express/`ws` if adopted; model matrix includes measured WER/RTF/first-audio and exact revisions/licenses; MVP has a target device profile.

## Phase 2 — Express foundation (M)

**Tasks:** Initialize TypeScript Express app; config validation; request IDs; structured logs; auth boundary; security headers/CORS; schema validation; error mapping; rate limits; health/readiness; graceful shutdown; Docker development setup.

**Dependencies:** Node LTS, Express, schema validator, logger. No inference service required.

**Risks:** configuration drift and leaking secrets through logs; readiness incorrectly reporting model availability.

**Acceptance:** app starts with validated config; health and readiness differ correctly; malformed requests map to safe errors; clean shutdown closes HTTP/WS resources.

## Phase 3 — Audio capture and upload (M)

**Tasks:** Browser permission/capture; AudioWorklet framing; audio device UI; bounded WSS handshake; file upload stream; MIME/content validation; private temp storage; FFmpeg probe/normalize; cleanup on every terminal path.

**Dependencies:** Web Audio, `ws`, streaming multipart parser or bounded Multer, FFmpeg.

**Risks:** browser codec differences, sample-rate conversion, malicious/oversized media, leaked temp files, queue growth.

**Acceptance:** Chrome/Firefox/Edge target browsers record and stream known fixtures; WAV/WebM/MP3 supported formats normalize or reject deterministically; size/duration limits and cleanup verified; no client-controlled filesystem path.

## Phase 4 — Speech-to-text (M)

**Tasks:** ASRProvider contract; local adapter service; file transcription; streaming/partial path; language detection; timestamps; transcript retrieval/export; optional diarization spike.

**Dependencies:** selected faster-whisper/streaming provider and its runtime; FFmpeg normalization.

**Risks:** model cold start, CPU latency, language-dependent error, Whisper hallucinations, ASR runtime incompatibility with Windows.

**Acceptance:** fixtures produce final transcript and timestamps; interim events are marked provisional; provider failure is recoverable and safe; measured WER/latency published for selected benchmark set; language confidence available where supported.

## Phase 5 — AI voice conversation (M)

**Tasks:** bounded conversation context; local LLM adapter; streaming text output; Kokoro or Piper adapter; sentence chunking/playback; transcript UI; text fallback.

**Dependencies:** local model server or runtime; TTS runtime; provider contracts.

**Risks:** serial latency, output chunk boundary artifacts, context growth, license mismatch.

**Acceptance:** a multi-turn conversation preserves context within configured bound; text appears before/with audio; one chunk can play while later text is generated; cancellation stops generation; chosen voices/model revisions are recorded in inventory.

## Phase 6 — Real-time streaming (L)

**Tasks:** binary audio protocol; VAD and hangover; partial transcripts; bounded queue/backpressure; turn IDs; heartbeat/reconnect policy; interruption/barge-in; stale-chunk rejection; concurrency cap; latency instrumentation.

**Dependencies:** stable WebSocket protocol, browser capture and ASR/TTS adapters.

**Risks:** echo/self-trigger, pauses mistaken for end-of-turn, out-of-order chunks, reconnect duplication, slow clients, GPU contention.

**Acceptance:** stress scenarios show bounded memory; interruption stops playback and provider work within target; sequence/generation rules reject late chunks; p50/p95 time-to-first-transcript/audio and concurrent sessions measured on named hardware; reconnect behavior is documented.

## Phase 7 — Direct speech-to-speech (L, experimental)

**Tasks:** implement `SpeechToSpeechProvider`; adapter for Qwen2.5-Omni and/or Moshi; test audio input/output, streaming, cancellation, multilingual behavior, interruption, hardware use and license fit; retain pipeline fallback.

**Dependencies:** GPU/runtime compatible with selected model; pinned weights; enough representative tests.

**Risks:** high VRAM/model load; weak portability; apparent streaming without true duplex; CC-BY obligations; harder debugging/interpretability.

**Acceptance:** comparison report uses same prompts/audio/device, measures latency/quality/resource use, verifies actual barge-in; feature remains opt-in unless it beats pipeline on agreed product criteria.

## Phase 8 — Reliability and security (L)

**Tasks:** threat model; auth/origin review; upload fuzz/limit checks; rate/concurrency controls; retention/deletion; encrypted storage; observability; provider timeouts/retries/circuit handling; failure/disconnect/OOM recovery; dependency/model SBOM and license audit.

**Dependencies:** product privacy and deployment requirements.

**Risks:** audio/transcript exposure, decoder exploits, denial of service, retries duplicating work, legal obligations varying by geography.

**Acceptance:** documented retention behavior and deletion; logs contain no raw audio/transcripts/secrets by default; resource caps enforced; outage/OOM recovery scenario documented; every distributed model and binary has provenance/license record.

## Phase 9 — Deployment (M–L)

**Tasks:** Docker images for Express and model workers; pinned runtime/weights; model cache strategy; Linux GPU configuration; reverse proxy WSS/TLS; secrets; migration/backup; metrics/alerts; rolling restart and graceful shutdown; CPU-only fallback profile.

**Dependencies:** chosen hosting target, GPU availability, operational SLO.

**Risks:** CUDA/driver mismatch, large image/model storage, cold start, GPU saturation, container FFmpeg licensing/build variation.

**Acceptance:** reproducible deployment from documented configuration; readiness waits for required adapters; WSS passes through proxy; model revisions/checksums pinned; capacity and rollback procedures written; a non-GPU development path remains usable.

## Critical path and MVP cut

Critical path: Phase 1 target/license decisions → Phase 2 foundation → Phase 3 capture/upload → Phase 4 ASR → Phase 5 LLM/TTS → Phase 6 bounded streaming. Start upload transcription before live streaming because it validates the ASR/model contract independently. Defer direct speech-to-speech, diarization, Redis, PostgreSQL, telephony, and denoising until the MVP measurements show a need.

MVP release gate: one browser; session create/end; WSS audio; partial/final transcript; local ASR + LLM + TTS; interruption; opt-in recording only; strict duration/size/concurrency limits; health/model readiness; latency/resource measurements on a named machine; written model/voice license inventory.
