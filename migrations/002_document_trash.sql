ALTER TABLE documents
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by TEXT,
  ADD COLUMN lifecycle_version BIGINT NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0),
  ADD CONSTRAINT documents_deletion_state CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL) OR
    (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
  );

CREATE INDEX documents_trash_idx ON documents(deleted_at DESC, id DESC)
  WHERE deleted_at IS NOT NULL;
