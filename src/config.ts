import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(250).default(50),
  MAX_AUDIO_SECONDS: z.coerce.number().int().min(1).max(3600).default(600),
  DATA_DIR: z.string().default('./data'),
  STORE_TRANSCRIPTS: z.enum(['true', 'false']).default('false'),
  API_KEY: z.string().default(''),
  ASR_BASE_URL: z.string().url().default('http://127.0.0.1:8001/v1'),
  ASR_API_KEY: z.string().default('local'),
  ASR_MODEL: z.string().default('whisper-1'),
  LLM_BASE_URL: z.string().url().default('http://127.0.0.1:11434/v1'),
  LLM_API_KEY: z.string().default('ollama'),
  LLM_MODEL: z.string().default('qwen2.5:7b'),
  TTS_BASE_URL: z.string().url().default('http://127.0.0.1:8880/v1'),
  TTS_API_KEY: z.string().default('local'),
  TTS_MODEL: z.string().default('kokoro'),
  TTS_VOICE: z.string().default('af_heart'),
  SYSTEM_PROMPT: z
    .string()
    .default('You are a helpful, concise voice assistant.'),
});

const result = schema.safeParse(process.env);
if (!result.success)
  throw new Error(`Invalid configuration: ${result.error.message}`);

export const config = {
  ...result.data,
  storeTranscripts: result.data.STORE_TRANSCRIPTS === 'true',
  dataDir: path.resolve(result.data.DATA_DIR),
  uploadsDir: path.resolve(result.data.DATA_DIR, 'uploads'),
  recordingsDir: path.resolve(result.data.DATA_DIR, 'recordings'),
  databasePath: path.resolve(result.data.DATA_DIR, 'micdrop.sqlite'),
};
