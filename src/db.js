import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incident_clusters (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_title     TEXT NOT NULL,
  incident_type     TEXT NOT NULL,
  location_tag      TEXT NOT NULL,
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at TEXT NOT NULL,
  last_reported_at  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reviewing','resolved'))
);

CREATE TABLE IF NOT EXISTS posts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  anonymous_author_token TEXT NOT NULL,          -- SHA-256 of a client-held secret; never a student ID or IP
  category               TEXT NOT NULL,
  raw_content            TEXT,                   -- purged after sanitization unless RETAIN_RAW_CONTENT=true
  sanitized_content      TEXT NOT NULL,
  location_tag           TEXT NOT NULL,
  severity_score         INTEGER NOT NULL CHECK (severity_score BETWEEN 1 AND 5),
  risk_indicators        TEXT NOT NULL DEFAULT '[]',
  moderation_notes       TEXT NOT NULL DEFAULT '[]',
  cluster_id             INTEGER REFERENCES incident_clusters(id),
  status                 TEXT NOT NULL DEFAULT 'pending_moderation'
                         CHECK (status IN ('pending_moderation','published','flagged_admin','withheld')),
  has_attachment         INTEGER NOT NULL DEFAULT 0,
  visibility             TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')), -- private: counselors only
  created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  mime_type  TEXT NOT NULL,
  data       BLOB NOT NULL,                       -- metadata (EXIF) stripped; admin-only, never public
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id     INTEGER REFERENCES incident_clusters(id),
  post_id        INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  severity_level INTEGER NOT NULL,
  summary_brief  TEXT NOT NULL,
  sent_to        TEXT NOT NULL,
  dispatched_at  TEXT NOT NULL,
  CHECK (cluster_id IS NOT NULL OR post_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS reactions (
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('support','heard','same','strength')),
  author_token TEXT NOT NULL,
  PRIMARY KEY (post_id, kind, author_token)
);

CREATE INDEX IF NOT EXISTS idx_posts_status   ON posts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_cat_loc  ON posts(category, location_tag, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_author   ON posts(anonymous_author_token);
CREATE INDEX IF NOT EXISTS idx_posts_cluster  ON posts(cluster_id);
`;

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Idempotent data fixes for databases created by earlier versions.
function migrate(db) {
  // Private reports (sent through the Adviser, counselors only).
  const cols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
  if (!cols.includes('visibility')) db.exec("ALTER TABLE posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");

  // Cluster titles no longer end in "Pattern" ("Cafeteria Bullying Pattern" -> "Cafeteria Bullying").
  db.exec(`UPDATE incident_clusters SET cluster_title = substr(cluster_title, 1, length(cluster_title) - 8) WHERE cluster_title LIKE '% Pattern'`);
}

export function resetDb(db) {
  db.exec(`
    DROP TABLE IF EXISTS reactions;
    DROP TABLE IF EXISTS escalations;
    DROP TABLE IF EXISTS attachments;
    DROP TABLE IF EXISTS posts;
    DROP TABLE IF EXISTS incident_clusters;
  `);
  db.exec(SCHEMA);
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
