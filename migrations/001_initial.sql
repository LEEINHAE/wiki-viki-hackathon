CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  editor_handle TEXT NOT NULL DEFAULT 'Editor-01',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revisions (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  editor_handle TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS redirects (
  id BIGSERIAL PRIMARY KEY,
  alias_slug TEXT NOT NULL UNIQUE,
  alias_title TEXT NOT NULL,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discussions (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  thread_title TEXT NOT NULL,
  body TEXT NOT NULL,
  editor_handle TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drafts (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  content TEXT NOT NULL,
  source_name TEXT,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  governance JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'blocked', 'published')),
  editor_handle TEXT NOT NULL DEFAULT 'Editor-01',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS revisions_document_created_idx ON revisions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS discussions_document_created_idx ON discussions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents(updated_at DESC);
CREATE INDEX IF NOT EXISTS documents_title_search_idx ON documents(LOWER(title));
CREATE INDEX IF NOT EXISTS drafts_status_created_idx ON drafts(status, created_at DESC);

