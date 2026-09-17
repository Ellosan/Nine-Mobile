/**
 * Local persistence for sessions, messages and provider profiles.
 *
 * SQLite via expo-sqlite. Profiles are stored here *without* their API key --
 * the key itself is in SecureStore keyed by profile id.
 */

import * as SQLite from 'expo-sqlite';
import type { ChatSession, ProviderProfile, StoredMessage, StoredToolCall, Role } from '../types';

const DB_NAME = 'agentkey.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db);
      return db;
    })().catch((err) => {
      // Let the next call retry rather than caching a rejected promise forever.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS profiles (
      id          TEXT PRIMARY KEY NOT NULL,
      name        TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      model       TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.7,
      max_tokens  INTEGER,
      has_api_key INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY NOT NULL,
      title      TEXT NOT NULL,
      profile_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY NOT NULL,
      session_id   TEXT NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      tool_calls   TEXT,
      tool_call_id TEXT,
      tool_name    TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages (session_id, created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

/* ------------------------------------------------------------------ */
/* Key/value settings                                                  */
/* ------------------------------------------------------------------ */

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    key
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM app_settings WHERE key = ?', key);
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

interface ProfileRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  temperature: number;
  max_tokens: number | null;
  has_api_key: number;
  created_at: number;
  updated_at: number;
}

function rowToProfile(r: ProfileRow): ProviderProfile {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    model: r.model,
    temperature: r.temperature,
    maxTokens: r.max_tokens,
    hasApiKey: r.has_api_key === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listProfiles(): Promise<ProviderProfile[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ProfileRow>('SELECT * FROM profiles ORDER BY created_at ASC');
  return rows.map(rowToProfile);
}

export async function upsertProfile(p: ProviderProfile): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO profiles (id, name, base_url, model, temperature, max_tokens, has_api_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       model = excluded.model,
       temperature = excluded.temperature,
       max_tokens = excluded.max_tokens,
       has_api_key = excluded.has_api_key,
       updated_at = excluded.updated_at`,
    p.id,
    p.name,
    p.baseUrl,
    p.model,
    p.temperature,
    p.maxTokens,
    p.hasApiKey ? 1 : 0,
    p.createdAt,
    p.updatedAt
  );
}

export async function deleteProfile(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM profiles WHERE id = ?', id);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

interface SessionRow {
  id: string;
  title: string;
  profile_id: string | null;
  created_at: number;
  updated_at: number;
}

export async function listSessions(): Promise<ChatSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<SessionRow>('SELECT * FROM sessions ORDER BY updated_at DESC');
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    profileId: r.profile_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getSession(id: string): Promise<ChatSession | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    profileId: r.profile_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertSession(s: ChatSession): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO sessions (id, title, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    s.id,
    s.title,
    s.profileId,
    s.createdAt,
    s.updatedAt
  );
}

export async function renameSession(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', title, Date.now(), id);
}

export async function touchSession(id: string, profileId?: string | null): Promise<void> {
  const db = await getDb();
  if (profileId !== undefined) {
    await db.runAsync(
      'UPDATE sessions SET updated_at = ?, profile_id = ? WHERE id = ?',
      Date.now(),
      profileId,
      id
    );
  } else {
    await db.runAsync('UPDATE sessions SET updated_at = ? WHERE id = ?', Date.now(), id);
  }
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  // Explicit delete as well, in case foreign_keys was not honoured.
  await db.runAsync('DELETE FROM messages WHERE session_id = ?', id);
  await db.runAsync('DELETE FROM sessions WHERE id = ?', id);
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  error: string | null;
  created_at: number;
}

function rowToMessage(r: MessageRow): StoredMessage {
  let toolCalls: StoredToolCall[] | undefined;
  if (r.tool_calls) {
    try {
      const parsed = JSON.parse(r.tool_calls);
      if (Array.isArray(parsed)) toolCalls = parsed as StoredToolCall[];
    } catch {
      toolCalls = undefined;
    }
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as Role,
    content: r.content,
    toolCalls,
    toolCallId: r.tool_call_id ?? undefined,
    toolName: r.tool_name ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
  };
}

export async function listMessages(sessionId: string): Promise<StoredMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    sessionId
  );
  return rows.map(rowToMessage);
}

export async function saveMessage(m: StoredMessage): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, tool_name, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       tool_calls = excluded.tool_calls,
       error = excluded.error`,
    m.id,
    m.sessionId,
    m.role,
    m.content,
    m.toolCalls ? JSON.stringify(m.toolCalls) : null,
    m.toolCallId ?? null,
    m.toolName ?? null,
    m.error ?? null,
    m.createdAt
  );
}

export async function deleteMessagesFrom(sessionId: string, createdAtInclusive: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM messages WHERE session_id = ? AND created_at >= ?',
    sessionId,
    createdAtInclusive
  );
}

export async function clearMessages(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM messages WHERE session_id = ?', sessionId);
}
