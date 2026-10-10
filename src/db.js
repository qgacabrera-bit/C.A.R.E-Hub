// Database layer: Supabase Postgres in production (via `pg` and the Transaction pooler string in
// DATABASE_URL), or an in-process Postgres (PGlite) for local development and tests.
// Application SQL keeps SQLite-style `?` placeholders; they are rewritten to $1, $2, ... here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

/** Rewrite `?` placeholders to `$n`, leaving question marks inside single-quoted literals alone. */
export function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (const ch of sql) {
    if (ch === "'") inString = !inString; // '' escapes toggle twice, so they stay inside the literal
    out += ch === '?' && !inString ? `$${++n}` : ch;
  }
  return out;
}

const withReturningId = (sql) => `${sql.trim().replace(/;$/, '')} RETURNING id`;

// One query surface over either driver: `query(text, params)` -> { rows, rowCount }, `exec(sql)`.
function api(q) {
  return {
    async get(sql, params = []) {
      return (await q.query(toPgPlaceholders(sql), params)).rows[0];
    },
    async all(sql, params = []) {
      return (await q.query(toPgPlaceholders(sql), params)).rows;
    },
    async run(sql, params = []) {
      return { changes: (await q.query(toPgPlaceholders(sql), params)).rowCount ?? 0 };
    },
    async insert(sql, params = []) {
      return Number((await q.query(toPgPlaceholders(withReturningId(sql)), params)).rows[0].id);
    },
    async exec(sql) {
      await q.exec(sql);
    },
  };
}

function migrationSql() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
}

function isLocalHost(url) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function openPostgres(url) {
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    ssl: isLocalHost(url) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  // pg runs multi-statement text through the simple-query protocol when there are no parameters.
  const wrap = (client) => ({
    query: (text, params) => client.query(text, params),
    exec: (sql) => client.query(sql),
  });

  // The schema is managed in Supabase - never run DDL against it from the app.
  const { t } = (await pool.query("SELECT to_regclass('public.posts') AS t")).rows[0];
  if (!t) {
    await pool.end();
    throw new Error('Database tables are missing. Apply supabase/migrations/*.sql to the Supabase project first.');
  }

  return {
    kind: 'postgres',
    ...api(wrap(pool)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(api(wrap(client)));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir) {
  // Dev/test only: loaded lazily so production installs never need it.
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  for (const sql of migrationSql()) await lite.exec(sql);

  const wrap = (q) => ({
    query: async (text, params) => {
      const res = await q.query(text, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? 0 };
    },
    exec: (sql) => q.exec(sql),
  });

  return {
    kind: 'pglite',
    ...api(wrap(lite)),
    tx: (fn) => lite.transaction((t) => fn(api(wrap(t)))),
    close: () => lite.close(),
  };
}

/**
 * Open the database. A postgres:// URL uses `pg`; ':memory:' uses an in-memory PGlite; an empty
 * string uses PGlite persisted under config.localDataDir.
 */
export async function openDb(target = config.databaseUrl) {
  if (/^postgres(ql)?:\/\//i.test(target)) return openPostgres(target);
  if (target === ':memory:') return openPglite(null);
  if (!target) return openPglite(config.localDataDir);
  throw new Error('DATABASE_URL must be a postgres:// connection string.');
}

export async function resetDb(db) {
  await db.exec('TRUNCATE reactions, escalations, attachments, posts, incident_clusters RESTART IDENTITY CASCADE');
}
