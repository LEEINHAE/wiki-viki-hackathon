-- Additive changes only: keep document IDs, URLs, aliases and history.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS governance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS document_state JSONB;
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

-- All application writes share the namespace lock. The function's individual SQL
-- statements use fresh READ COMMITTED snapshots after waiting for that lock.
CREATE OR REPLACE FUNCTION wv_save_document_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  d documents%ROWTYPE;
  a JSONB;
  names JSONB := COALESCE(p->'aliases', '[]'::jsonb);
  target_id BIGINT := NULLIF(p->>'id', '')::bigint;
  stamp TIMESTAMPTZ;
  snapshot JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(21470921, 2);
  IF target_id IS NOT NULL THEN
    SELECT * INTO d FROM documents WHERE id=target_id FOR UPDATE;
    IF NOT FOUND OR d.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'document_missing'; END IF;
    IF NULLIF(p->>'version','') IS NULL OR d.updated_at <> (p->>'version')::timestamptz THEN
      RAISE EXCEPTION 'version_conflict';
    END IF;
  END IF;
  IF COALESCE(length(trim(p->>'title')),0)=0 OR COALESCE(length(p->>'content'),0)=0 OR length(p->>'content')>200000
    OR COALESCE(length(p->>'slug'),0)=0 THEN RAISE EXCEPTION 'invalid_document'; END IF;
  IF EXISTS (SELECT 1 FROM documents WHERE (lower(title)=lower(p->>'title') OR slug=p->>'slug' OR slug=p->>'titleSlug') AND id IS DISTINCT FROM target_id)
    OR EXISTS (SELECT 1 FROM redirects WHERE (alias_slug=p->>'slug' OR alias_slug=p->>'titleSlug') AND document_id IS DISTINCT FROM target_id) THEN
    RAISE EXCEPTION 'name_conflict';
  END IF;
  IF jsonb_array_length(names)>50 THEN RAISE EXCEPTION 'invalid_alias'; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(names) LOOP
    IF COALESCE(a->>'slug','')='' THEN RAISE EXCEPTION 'invalid_alias'; END IF;
    IF EXISTS (SELECT 1 FROM documents WHERE slug=a->>'slug' AND id IS DISTINCT FROM target_id)
      OR EXISTS (SELECT 1 FROM redirects WHERE alias_slug=a->>'slug' AND document_id IS DISTINCT FROM target_id) THEN
      RAISE EXCEPTION 'alias_conflict';
    END IF;
  END LOOP;
  stamp := GREATEST(clock_timestamp(), d.updated_at + interval '1 microsecond');
  IF target_id IS NULL THEN
    INSERT INTO documents (slug,title,content,editor_handle,field,description,source_name,governance,updated_at)
    VALUES (p->>'slug',p->>'title',p->>'content',p->>'editor',p->>'field',p->>'description',p->>'sourceName',COALESCE(p->'governance','{}'),stamp)
    RETURNING * INTO d;
  ELSE
    UPDATE documents SET title=p->>'title',content=p->>'content',editor_handle=p->>'editor',
      field=p->>'field',description=p->>'description',source_name=p->>'sourceName',
      governance=COALESCE(p->'governance','{}'),updated_at=stamp WHERE id=target_id RETURNING * INTO d;
  END IF;
  DELETE FROM redirects WHERE document_id=d.id;
  INSERT INTO redirects (alias_slug,alias_title,document_id)
    SELECT DISTINCT ON (item->>'slug') item->>'slug',item->>'title',d.id
    FROM jsonb_array_elements(names) item WHERE item->>'slug'<>d.slug;
  snapshot := jsonb_build_object('title',d.title,'slug',d.slug,'field',d.field,'description',d.description,
    'sourceName',d.source_name,'aliases',names,'deletedAt',d.deleted_at);
  INSERT INTO revisions (document_id,content,editor_handle,summary,document_state,details)
    VALUES (d.id,d.content,d.editor_handle,COALESCE(p->>'summary',''),snapshot,COALESCE(p->'details','{}'));
  RETURN to_jsonb(d) || jsonb_build_object('version',d.updated_at::text);
END $$;

CREATE OR REPLACE FUNCTION wv_trash_document_v1(p_id BIGINT, p_version TEXT, p_editor TEXT, p_restore BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE d documents%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(21470921, 2);
  SELECT * INTO d FROM documents WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_missing'; END IF;
  IF NULLIF(p_version,'') IS NULL OR d.updated_at<>p_version::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
  IF (p_restore AND d.deleted_at IS NULL) OR (NOT p_restore AND d.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'version_conflict';
  END IF;
  UPDATE documents SET deleted_at=CASE WHEN p_restore THEN NULL ELSE clock_timestamp() END,
    deleted_by=CASE WHEN p_restore THEN NULL ELSE p_editor END,
    updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
    WHERE id=p_id RETURNING * INTO d;
  INSERT INTO revisions (document_id,content,editor_handle,summary,details)
    VALUES (d.id,d.content,p_editor,CASE WHEN p_restore THEN '휴지통에서 복구' ELSE '휴지통으로 이동' END,
      jsonb_build_object('action',CASE WHEN p_restore THEN 'restore' ELSE 'trash' END));
  RETURN to_jsonb(d)||jsonb_build_object('version',d.updated_at::text);
END $$;

CREATE OR REPLACE FUNCTION wv_publish_draft_v1(p_id BIGINT, p_version TEXT, p_editor TEXT, p_governance JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE draft drafts%ROWTYPE; result JSONB; names JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(21470921, 2);
  SELECT * INTO draft FROM drafts WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR draft.status='published' THEN RAISE EXCEPTION 'draft_missing'; END IF;
  IF NULLIF(p_version,'') IS NULL OR draft.updated_at<>p_version::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
  IF p_governance->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
  names := COALESCE(p_governance->'aliasRecords','[]'::jsonb);
  -- Optional aliases never steal another document's address. The primary title
  -- is checked by wv_save_document_v1 and a conflict always aborts publication.
  SELECT COALESCE(jsonb_agg(a),'[]'::jsonb) INTO names FROM jsonb_array_elements(names) a
    WHERE NOT EXISTS (SELECT 1 FROM documents WHERE slug=a->>'slug')
      AND NOT EXISTS (SELECT 1 FROM redirects WHERE alias_slug=a->>'slug');
  result := wv_save_document_v1(jsonb_build_object('title',draft.title,'slug',draft.slug,'content',draft.content,
    'editor',p_editor,'field',draft.field,'description',draft.description,'sourceName',COALESCE(draft.source_name,''),
    'aliases',names,'governance',p_governance-'aliasRecords','summary','초안 '||draft.id||' 검토 후 게시'));
  UPDATE drafts SET status='published',editor_handle=p_editor,
    governance=(p_governance-'aliasRecords')||jsonb_build_object('publishedDocumentId',result->'id'),
    updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=p_id;
  RETURN result;
END $$;
