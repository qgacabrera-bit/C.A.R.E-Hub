-- Resolution articles get a byline and a picture.
--   Byline: the counselor's name, and whether Kali (the AI adviser) helped write it.
--   Picture: a preset illustration, a counselor-uploaded image (metadata stripped), or one Kali generated.
-- Idempotent: safe to run more than once.

ALTER TABLE incident_articles ADD COLUMN IF NOT EXISTS author_name text NOT NULL DEFAULT '';
ALTER TABLE incident_articles ADD COLUMN IF NOT EXISTS byline_style text NOT NULL DEFAULT 'counselor'
  CHECK (byline_style IN ('counselor','kali_led','counselor_led'));
ALTER TABLE incident_articles ADD COLUMN IF NOT EXISTS picture_kind text NOT NULL DEFAULT 'preset'
  CHECK (picture_kind IN ('preset','upload','ai'));
ALTER TABLE incident_articles ADD COLUMN IF NOT EXISTS picture_preset text NOT NULL DEFAULT '';
ALTER TABLE incident_articles ADD COLUMN IF NOT EXISTS picture_mime text;
ALTER TABLE incident_articles ADD COLUMN IF NOT EXISTS picture_data bytea;  -- public once the article is published
