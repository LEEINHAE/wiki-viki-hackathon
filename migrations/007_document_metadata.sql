-- Keep the already-tested atomic writer as the core. This wrapper writes tags
-- and the corresponding snapshot within the same database transaction.
ALTER FUNCTION wv_save_document_v1(JSONB) RENAME TO wv_save_document_core_v1;
CREATE OR REPLACE FUNCTION wv_save_document_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE result JSONB; names JSONB; previous JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(21470921,2);
  IF NULLIF(p->>'id','') IS NOT NULL THEN
    SELECT governance INTO previous FROM documents WHERE id=(p->>'id')::bigint FOR UPDATE;
  END IF;
  IF p ? 'tags' THEN names:=p->'tags';
  ELSE SELECT COALESCE(jsonb_agg(tag ORDER BY tag),'[]'::jsonb) INTO names FROM wv_document_tags WHERE document_id=NULLIF(p->>'id','')::bigint; END IF;
  IF jsonb_typeof(names)<>'array' OR jsonb_array_length(names)>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(names) t WHERE length(trim(t)) NOT BETWEEN 1 AND 40) THEN RAISE EXCEPTION 'invalid_tags'; END IF;
  p:=p||jsonb_build_object('governance',COALESCE(previous,'{}'::jsonb)||COALESCE(p->'governance','{}'::jsonb)||jsonb_build_object('reviewState',CASE WHEN previous->>'reviewState'='example' OR p->'governance'->>'reviewState'='example' THEN 'example' ELSE 'needs_review' END));
  result:=wv_save_document_core_v1(p);
  DELETE FROM wv_document_tags WHERE document_id=(result->>'id')::bigint;
  INSERT INTO wv_document_tags SELECT (result->>'id')::bigint,trim(t) FROM jsonb_array_elements_text(names) t GROUP BY trim(t);
  UPDATE revisions SET document_state=document_state||jsonb_build_object('tags',names,'governance',p->'governance')
    WHERE id=(SELECT id FROM revisions WHERE document_id=(result->>'id')::bigint ORDER BY created_at DESC,id DESC LIMIT 1);
  RETURN result;
END $$;
