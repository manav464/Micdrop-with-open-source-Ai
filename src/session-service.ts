import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { storage, type Message } from './storage.js';
import { asrProvider, llmProvider, ttsProvider } from './providers.js';

export function createSession() {
  const expiresAt = new Date(
    Date.now() + config.SESSION_TTL_MINUTES * 60_000
  ).toISOString();
  return storage.createSession(randomUUID(), expiresAt);
}

export async function transcribeFile(
  path: string,
  filename: string,
  sessionId?: string,
  signal?: AbortSignal
) {
  const result = await asrProvider.transcribe(path, filename, signal);
  const id = randomUUID();
  const persisted = config.storeTranscripts;
  if (persisted) storage.saveTranscript({ id, sessionId, filename, ...result });
  return { id, persisted, ...result };
}

export async function* respondToTurn(
  sessionId: string,
  userText: string,
  signal: AbortSignal
) {
  const session = storage.getSession(sessionId);
  if (!session || session.endedAt || Date.parse(session.expiresAt) < Date.now())
    throw new Error('Session is unavailable or expired');
  const history: Message[] = [
    ...session.history,
    { role: 'user', content: userText },
  ].slice(-20);
  let answer = '';
  let pending = '';
  for await (const delta of llmProvider.stream(history, signal)) {
    answer += delta;
    pending += delta;
    yield { type: 'assistant.text.delta', text: delta } as const;
    const boundary = pending.search(/[.!?\n](?:\s|$)/);
    if (boundary >= 0 && pending.slice(0, boundary + 1).trim()) {
      const sentence = pending.slice(0, boundary + 1).trim();
      pending = pending.slice(boundary + 1).trimStart();
      const wav = await ttsProvider.synthesize(sentence, signal);
      yield {
        type: 'assistant.audio',
        audio: Buffer.from(wav).toString('base64'),
        format: 'audio/wav',
      } as const;
    }
  }
  if (pending.trim()) {
    const wav = await ttsProvider.synthesize(pending.trim(), signal);
    yield {
      type: 'assistant.audio',
      audio: Buffer.from(wav).toString('base64'),
      format: 'audio/wav',
    } as const;
  }
  if (answer.trim())
    storage.saveHistory(sessionId, [
      ...history,
      { role: 'assistant', content: answer },
    ]);
  yield { type: 'assistant.turn.end', text: answer } as const;
}
