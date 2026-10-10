-- Resolution articles: after a recurring incident is resolved, a counselor writes (or has the AI draft)
-- a public article about it, reviews it, and publishes it to the campus updates carousel.
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS incident_articles (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id        integer NOT NULL UNIQUE REFERENCES incident_clusters(id) ON DELETE CASCADE,
  headline          text NOT NULL,
  summary           text NOT NULL,
  body              text NOT NULL,                  -- paragraphs separated by blank lines
  counselor_context text NOT NULL DEFAULT '',       -- counselor-only notes given to the AI; never public
  source            text NOT NULL DEFAULT 'counselor' CHECK (source IN ('counselor','ai','template')),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at        text NOT NULL,
  updated_at        text NOT NULL,
  published_at      text
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON incident_articles(status, published_at);

-- Same lockdown as 0001: no access through Supabase's public REST API.
ALTER TABLE incident_articles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON incident_articles FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON incident_articles FROM authenticated;
  END IF;
END $$;
