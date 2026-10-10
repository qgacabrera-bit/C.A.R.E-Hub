-- C.A.R.E. Hub schema for Supabase (Postgres). Idempotent: safe to run more than once.
-- Timestamps stay ISO-8601 UTC strings (TEXT) exactly as the app wrote them under SQLite, so the
-- string comparisons in the clustering code keep working unchanged.

CREATE TABLE IF NOT EXISTS incident_clusters (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_title     text NOT NULL,
  incident_type     text NOT NULL,
  location_tag      text NOT NULL,
  report_count      integer NOT NULL DEFAULT 0,
  first_reported_at text NOT NULL,
  last_reported_at  text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reviewing','resolved'))
);

CREATE TABLE IF NOT EXISTS posts (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anonymous_author_token text NOT NULL,           -- SHA-256 of a client-held secret; never a student ID or IP
  category               text NOT NULL,
  raw_content            text,                    -- purged after sanitization unless RETAIN_RAW_CONTENT=true
  sanitized_content      text NOT NULL,
  location_tag           text NOT NULL,
  severity_score         integer NOT NULL CHECK (severity_score BETWEEN 1 AND 5),
  risk_indicators        text NOT NULL DEFAULT '[]',
  moderation_notes       text NOT NULL DEFAULT '[]',
  cluster_id             integer REFERENCES incident_clusters(id),
  status                 text NOT NULL DEFAULT 'pending_moderation'
                         CHECK (status IN ('pending_moderation','published','flagged_admin','withheld')),
  has_attachment         integer NOT NULL DEFAULT 0,
  visibility             text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')), -- private: counselors only
  created_at             text NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id    integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  mime_type  text NOT NULL,
  data       bytea NOT NULL,                      -- metadata (EXIF) stripped; admin-only, never public
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id     integer REFERENCES incident_clusters(id),
  post_id        integer REFERENCES posts(id) ON DELETE CASCADE,
  severity_level integer NOT NULL,
  summary_brief  text NOT NULL,
  sent_to        text NOT NULL,
  dispatched_at  text NOT NULL,
  CHECK (cluster_id IS NOT NULL OR post_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS reactions (
  post_id      integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('support','heard','same','strength')),
  author_token text NOT NULL,
  PRIMARY KEY (post_id, kind, author_token)
);

CREATE INDEX IF NOT EXISTS idx_posts_status   ON posts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_cat_loc  ON posts(category, location_tag, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_author   ON posts(anonymous_author_token);
CREATE INDEX IF NOT EXISTS idx_posts_cluster  ON posts(cluster_id);
CREATE INDEX IF NOT EXISTS idx_escalations_post    ON escalations(post_id);
CREATE INDEX IF NOT EXISTS idx_escalations_cluster ON escalations(cluster_id);
CREATE INDEX IF NOT EXISTS idx_attachments_post    ON attachments(post_id);

-- ---------------------------------------------------------------------------------------------
-- Privacy: Supabase publishes every public-schema table through its REST API using the public
-- "anon" key. Turn on Row Level Security with NO policies, so that API can read and write nothing.
-- The app itself connects with the database owner role (server-side DATABASE_URL), which bypasses RLS.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE incident_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactions         ENABLE ROW LEVEL SECURITY;

-- Belt and braces: also remove the table privileges Supabase grants by default. The roles only
-- exist on Supabase, so this is skipped on a plain Postgres or in tests.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END $$;
