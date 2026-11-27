import { config } from './config.js';
import type { Message } from './storage.js';

const timeoutMs = 120_000;
function authHeaders(key: string) {
  return { Authorization: `Bearer ${key}` };
}
async function checkedFetch(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Provider timeout')),
    timeoutMs
  );
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Inference provider returned HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export type TranscriptResult = {
  text: string;
  language?: string;
  segments: Array<{ start?: number; end?: number; text: string }>;
};

export const asrProvider = {
  async transcribe(
    filePath: string,
    originalName: string,
    signal?: AbortSignal
  ): Promise<TranscriptResult> {
    const form = new FormData();
    const bytes = await (await import('node:fs/promises')).readFile(filePath);
    const audioBytes = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    form.append('file', new Blob([audioBytes]), originalName);
    form.append('model', config.ASR_MODEL);
    form.append('response_format', 'verbose_json');
    const response = await checkedFetch(
      `${config.ASR_BASE_URL}/audio/transcriptions`,
      {
        method: 'POST',
        headers: authHeaders(config.ASR_API_KEY),
        body: form,
      },
      signal
    );
    const data = (await response.json()) as {
      text?: string;
      language?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };
    const segments = (data.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text ?? '',
    }));
    return {
      text:
        data.text ??
        segments
          .map((s) => s.text)
          .join(' ')
          .trim(),
      language: data.language,
      segments,
    };
  },
};

export const llmProvider = {
  async *stream(
    history: Message[],
    signal: AbortSignal
  ): AsyncGenerator<string> {
    const response = await checkedFetch(
      `${config.LLM_BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(config.LLM_API_KEY),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          stream: true,
          messages: [
            { role: 'system', content: config.SYSTEM_PROMPT },
            ...history,
          ],
        }),
      },
      signal
    );
    if (!response.body) throw new Error('LLM provider did not return a stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const text = parsed.choices?.[0]?.delta?.content;
            if (text) yield text;
          } catch {
            /* Ignore non-JSON SSE comments. */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

export const ttsProvider = {
  async synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await checkedFetch(
      `${config.TTS_BASE_URL}/audio/speech`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(config.TTS_API_KEY),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.TTS_MODEL,
          voice: config.TTS_VOICE,
          input: text,
          response_format: 'wav',
        }),
      },
      signal
    );
    return new Uint8Array(await response.arrayBuffer());
  },
};

export async function providerStatus() {
  const check = async (name: string, base: string) => {
    try {
      const response = await fetch(`${base}/models`, {
        signal: AbortSignal.timeout(1800),
      });
      return { name, configured: true, reachable: response.ok };
    } catch {
      return { name, configured: true, reachable: false };
    }
  };
  return Promise.all([
    check('asr', config.ASR_BASE_URL),
    check('llm', config.LLM_BASE_URL),
    check('tts', config.TTS_BASE_URL),
  ]);
}
