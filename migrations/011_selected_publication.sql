CREATE FUNCTION wv_publish_selected_v1(p JSONB, p_editor TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE item JSONB; draft drafts%ROWTYPE; result JSONB; results JSONB:='[]'::jsonb;
BEGIN
  IF jsonb_typeof(p)<>'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 8 OR
    (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p))<>jsonb_array_length(p)
    THEN RAISE EXCEPTION 'invalid_selection'; END IF;
  PERFORM pg_advisory_xact_lock(21470921,2);
  FOR item IN SELECT value FROM jsonb_array_elements(p) ORDER BY (value->>'id')::bigint LOOP
    SELECT * INTO draft FROM drafts WHERE id=(item->>'id')::bigint FOR UPDATE;
    IF NOT FOUND OR draft.status<>'review' OR draft.updated_at<>(item->>'version')::timestamptz
      OR draft.governance->'review'->>'version' IS DISTINCT FROM item->>'version'
      THEN RAISE EXCEPTION 'version_conflict'; END IF;
    result:=wv_publish_draft_v1(draft.id,item->>'version',p_editor,item->'inspection');
    results:=results||jsonb_build_array(result);
  END LOOP;
  RETURN results;
END $$;
