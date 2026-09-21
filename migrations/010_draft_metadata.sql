ALTER TABLE drafts ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK(jsonb_typeof(tags)='array' AND jsonb_array_length(tags)<=20);
CREATE TABLE wv_document_sources (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES wv_upload_sources(id),
  draft_id BIGINT REFERENCES drafts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id,source_id)
);
CREATE FUNCTION wv_keep_published_sources_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id BIGINT;
BEGIN
  target_id:=COALESCE((NEW.governance->>'publishedDocumentId')::bigint,(NEW.governance->'mergedInto'->>'id')::bigint);
  IF target_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO wv_document_sources(document_id,source_id,draft_id)
    SELECT target_id,source_id,NEW.id FROM wv_draft_sources WHERE draft_id=NEW.id ON CONFLICT DO NOTHING;
  INSERT INTO wv_document_tags(document_id,tag)
    SELECT target_id,trim(value) FROM jsonb_array_elements_text(NEW.tags)
    WHERE length(trim(value)) BETWEEN 1 AND 40 ON CONFLICT DO NOTHING;
  UPDATE revisions SET document_state=document_state||jsonb_build_object(
    'tags',(SELECT COALESCE(jsonb_agg(tag ORDER BY tag),'[]') FROM wv_document_tags WHERE document_id=target_id),
    'sourceIds',(SELECT COALESCE(jsonb_agg(source_id ORDER BY source_id),'[]') FROM wv_document_sources WHERE document_id=target_id))
    WHERE id=(SELECT id FROM revisions WHERE document_id=target_id ORDER BY created_at DESC,id DESC LIMIT 1);
  RETURN NEW;
END $$;
CREATE TRIGGER wv_publish_provenance AFTER UPDATE OF status ON drafts
  FOR EACH ROW WHEN(NEW.status='published' AND OLD.status<>'published') EXECUTE FUNCTION wv_keep_published_sources_v1();

-- Preserve recorded source relationships; do not invent old revision snapshots.
INSERT INTO wv_document_sources(document_id,source_id,draft_id)
 SELECT d.id,ds.source_id,dr.id FROM drafts dr
 JOIN documents d ON d.id=COALESCE((dr.governance->>'publishedDocumentId')::bigint,(dr.governance->'mergedInto'->>'id')::bigint)
 JOIN wv_draft_sources ds ON ds.draft_id=dr.id WHERE dr.status='published' ON CONFLICT DO NOTHING;
