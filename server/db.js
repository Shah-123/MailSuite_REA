import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  recipients TEXT NOT NULL,
  source TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS emails_user_sent ON emails(user_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  UNIQUE (email_id, position)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('open', 'click')),
  occurred_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  client TEXT,
  os TEXT,
  device TEXT,
  ignored_reason TEXT
);
CREATE INDEX IF NOT EXISTS events_email ON events(email_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at);
`;

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction, rolling back if it throws.
export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
