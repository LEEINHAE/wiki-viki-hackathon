-- Keep addresses introduced after a restored revision without pretending that
-- they were aliases recorded in that earlier revision.
CREATE TABLE wv_preserved_routes (
 id BIGSERIAL PRIMARY KEY,
 slug TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 document_id BIGINT NOT NULL REFERENCES documents(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE VIEW wv_resolved_names AS
 SELECT d.slug AS alias_slug,d.title AS alias_title,p.target_id AS document_id FROM wv_document_roots p JOIN wv_visible_documents d ON d.id=p.source_id
 UNION SELECT r.alias_slug,r.alias_title,p.target_id FROM redirects r JOIN wv_document_roots p ON p.source_id=r.document_id
 UNION SELECT r.slug,r.title,p.target_id FROM wv_preserved_routes r JOIN wv_document_roots p ON p.source_id=r.document_id;
CREATE OR REPLACE FUNCTION wv_save_document_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF EXISTS(SELECT 1 FROM documents WHERE id=NULLIF(p->>'id','')::bigint AND wv_merged_into IS NOT NULL) THEN RAISE EXCEPTION 'document_merged'; END IF;
 IF EXISTS(SELECT 1 FROM wv_preserved_routes r WHERE r.document_id IS DISTINCT FROM NULLIF(p->>'id','')::bigint
 AND (r.slug=p->>'slug' OR r.slug=p->>'titleSlug' OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p->'aliases','[]')) a WHERE a->>'slug'=r.slug))) THEN RAISE EXCEPTION 'name_conflict'; END IF;
 RETURN wv_save_document_metadata_v1(p);
END $$;

CREATE FUNCTION wv_restore_document_state_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE d documents%ROWTYPE; r revisions%ROWTYPE; state JSONB; result JSONB; merge_target BIGINT; rid BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF wv_writer_rank_v1()<4 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO d FROM wv_visible_documents WHERE id=(p->>'id')::bigint FOR UPDATE;
 IF NOT FOUND OR d.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 SELECT * INTO r FROM revisions WHERE id=(p->>'revisionId')::bigint AND document_id=d.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid_revision'; END IF;
 state:=r.document_state;
 IF state->>'stateVersion' IS DISTINCT FROM '3' OR NOT(state ?& ARRAY['title','slug','field','description','sourceName','governance','aliases','tags','sourceIds','minRole','deletedAt','deletedBy','archivedAt','mergedInto','ownerId','reviewedAt','reviewedBy','nextReviewOn']) THEN RAISE EXCEPTION 'incomplete_snapshot'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' OR p->>'reviewed' IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 merge_target:=NULLIF(state->>'mergedInto','')::bigint;
 IF merge_target IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM wv_current_documents WHERE id=merge_target AND deleted_at IS NULL AND wv_archived_at IS NULL) OR merge_target=d.id THEN RAISE EXCEPTION 'merge_target_changed'; END IF;
  IF EXISTS(WITH RECURSIVE descendants AS (SELECT id,wv_merged_into FROM documents WHERE id=merge_target UNION SELECT x.id,x.wv_merged_into FROM documents x JOIN descendants p ON x.id=p.wv_merged_into) SELECT 1 FROM descendants WHERE id=d.id) THEN RAISE EXCEPTION 'merge_target_changed'; END IF;
 END IF;
 INSERT INTO wv_preserved_routes(slug,title,document_id)
 SELECT alias_slug,alias_title,d.id FROM redirects WHERE document_id=d.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'aliases') a WHERE a->>'slug'=alias_slug) AND alias_slug<>state->>'slug'
 ON CONFLICT(slug) DO NOTHING;
 IF d.slug<>state->>'slug' THEN
  IF EXISTS(SELECT 1 FROM documents WHERE slug=state->>'slug' AND id<>d.id) OR EXISTS(SELECT 1 FROM redirects WHERE alias_slug=state->>'slug' AND document_id<>d.id) THEN RAISE EXCEPTION 'name_conflict'; END IF;
  INSERT INTO wv_preserved_routes(slug,title,document_id) VALUES(d.slug,d.title,d.id) ON CONFLICT(slug) DO NOTHING;
 END IF;
 -- Temporarily reopen only within this transaction so the common writer can
 -- apply its existing name checks, tag validation and revision insertion.
 UPDATE documents SET deleted_at=NULL,deleted_by=NULL,wv_merged_into=NULL,slug=state->>'slug' WHERE id=d.id;
 result:=wv_save_document_v1(jsonb_build_object('id',d.id,'version',d.updated_at::text,'title',state->>'title','slug',state->>'slug','content',r.content,
 'editor',p->>'editor','field',state->>'field','description',state->>'description','sourceName',state->>'sourceName','aliases',state->'aliases','tags',state->'tags','governance',state->'governance',
 'summary','리비전 '||r.id||' 전체 문서 상태 복원','details',jsonb_build_object('type','full_restore','revisionId',r.id,'inspection',p->'inspection','preservedAddresses',true)));
 UPDATE documents SET governance=state->'governance',deleted_at=(state->>'deletedAt')::timestamptz,deleted_by=state->>'deletedBy',
 wv_min_role=state->>'minRole',wv_archived_at=(state->>'archivedAt')::timestamptz,wv_merged_into=merge_target,
 wv_owner_id=(state->>'ownerId')::bigint,wv_reviewed_at=(state->>'reviewedAt')::timestamptz,wv_reviewed_by=(state->>'reviewedBy')::bigint,wv_next_review_on=(state->>'nextReviewOn')::date WHERE id=d.id;
 DELETE FROM wv_document_sources WHERE document_id=d.id;
 INSERT INTO wv_document_sources(document_id,source_id) SELECT d.id,v::bigint FROM jsonb_array_elements_text(state->'sourceIds') v;
 SELECT id INTO rid FROM revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1;
 UPDATE revisions SET document_state=wv_document_state_v1(d.id) WHERE id=rid;
 RETURN jsonb_build_object('id',d.id,'slug',state->>'slug','revisionId',rid);
END $$;
