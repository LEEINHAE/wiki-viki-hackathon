CREATE OR REPLACE FUNCTION wv_apply_draft_merge_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE draft drafts%ROWTYPE; target documents%ROWTYPE; plan JSONB; names JSONB; result JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(21470921,2);
  SELECT * INTO draft FROM drafts WHERE id=(p->>'draftId')::bigint FOR UPDATE;
  IF NOT FOUND OR draft.status='published' THEN RAISE EXCEPTION 'draft_missing'; END IF;
  plan := draft.governance->'merge';
  IF NULLIF(p->>'version','') IS NULL OR draft.updated_at<>(p->>'version')::timestamptz
    OR plan IS NULL OR plan->>'id' IS DISTINCT FROM p->>'mergeId'
    OR plan->>'draftFingerprint' IS DISTINCT FROM p->>'draftFingerprint' THEN RAISE EXCEPTION 'version_conflict'; END IF;
  SELECT * INTO target FROM documents WHERE id=(plan->>'targetId')::bigint FOR UPDATE;
  IF NOT FOUND OR target.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'document_missing'; END IF;
  IF target.updated_at<>(plan->>'targetVersion')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
  IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('title',alias_title,'slug',alias_slug)),'[]'::jsonb)
    INTO names FROM redirects WHERE document_id=target.id;
  names := names || COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(p->'aliases') a
    WHERE NOT EXISTS(SELECT 1 FROM documents WHERE slug=a->>'slug')
    AND NOT EXISTS(SELECT 1 FROM redirects WHERE alias_slug=a->>'slug')),'[]'::jsonb);
  result := wv_save_document_v1(jsonb_build_object('id',target.id,'version',target.updated_at::text,
    'slug',target.slug,'title',target.title,'content',p->>'content','editor',p->>'editor',
    'field',target.field,'description',target.description,'sourceName',target.source_name,'aliases',names,
    'governance',p->'inspection','summary','[AI 통합 · 새 초안 우선] '||(plan->>'summary'),
    'details',jsonb_build_object('type','ai_merge','policy','incoming','draftId',draft.id,'draftTitle',draft.title,
      'sourceName',draft.source_name,'summary',plan->>'summary','conflicts',plan->'conflicts',
      'manuallyEdited',(p->>'content') IS DISTINCT FROM (plan->>'content'))));
  UPDATE drafts SET status='published',editor_handle=p->>'editor',
    governance=(governance-'merge')||jsonb_build_object('mergedInto',jsonb_build_object('id',target.id,'title',target.title,'slug',target.slug)),
    updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=draft.id;
  RETURN result;
END $$;
