import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.uploadsDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.recordingsDir, { recursive: true, mode: 0o700 });
const db = new Database(config.databasePath);
const transientHistory = new Map<string, Message[]>();
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    ended_at TEXT, history TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT NOT NULL,
    filename TEXT NOT NULL, transcript TEXT NOT NULL, language TEXT,
    segments TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
    filename TEXT NOT NULL, file_path TEXT NOT NULL
  );
`);

export type Message = { role: 'user' | 'assistant'; content: string };
export type Session = {
  id: string;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  history: Message[];
};

export const storage = {
  createSession(id: string, expiresAt: string): Session {
    const createdAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)'
    ).run(id, createdAt, expiresAt);
    transientHistory.set(id, []);
    return { id, createdAt, expiresAt, endedAt: null, history: [] };
  },
  getSession(id: string): Session | undefined {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      endedAt: row.ended_at || null,
      history: transientHistory.get(id) ?? [],
    };
  },
  saveHistory(id: string, history: Message[]) {
    if (transientHistory.has(id)) transientHistory.set(id, history.slice(-24));
  },
  endSession(id: string) {
    db.prepare(
      'UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?'
    ).run(new Date().toISOString(), id);
    transientHistory.delete(id);
  },
  saveTranscript(item: {
    id: string;
    sessionId?: string;
    filename: string;
    transcript: string;
    language?: string;
    segments: unknown[];
  }) {
    db.prepare(
      'INSERT INTO transcripts (id, session_id, created_at, filename, transcript, language, segments) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      item.id,
      item.sessionId ?? null,
      new Date().toISOString(),
      path.basename(item.filename),
      item.transcript,
      item.language ?? null,
      JSON.stringify(item.segments)
    );
  },
  getTranscript(id: string) {
    const row = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as
      Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id || undefined,
      createdAt: row.created_at,
      filename: row.filename,
      transcript: row.transcript,
      language: row.language || undefined,
      segments: JSON.parse(row.segments) as unknown[],
    };
  },
  deleteTranscript(id: string) {
    const result = db.prepare('DELETE FROM transcripts WHERE id = ?').run(id);
    return result.changes > 0;
  },
  saveRecording(item: {
    id: string;
    sessionId: string;
    filename: string;
    filePath: string;
  }) {
    db.prepare(
      'INSERT INTO recordings (id, session_id, created_at, filename, file_path) VALUES (?, ?, ?, ?, ?)'
    ).run(
      item.id,
      item.sessionId,
      new Date().toISOString(),
      path.basename(item.filename),
      item.filePath
    );
  },
  getRecording(id: string) {
    return db
      .prepare(
        'SELECT id, session_id AS sessionId, created_at AS createdAt, filename, file_path AS filePath FROM recordings WHERE id = ?'
      )
      .get(id) as
      | {
          id: string;
          sessionId: string;
          createdAt: string;
          filename: string;
          filePath: string;
        }
      | undefined;
  },
  deleteRecording(id: string) {
    const item = this.getRecording(id);
    if (!item) return undefined;
    db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    return item;
  },
  isReady() {
    return !db.open ? false : true;
  },
  close() {
    db.close();
  },
};

export function cleanupExpiredSessions() {
  db.prepare(
    'UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE ended_at IS NULL AND expires_at < ?'
  ).run(new Date().toISOString(), new Date().toISOString());
  for (const row of db
    .prepare('SELECT id FROM sessions WHERE ended_at IS NOT NULL')
    .all() as Array<{ id: string }>)
    transientHistory.delete(row.id);
}
