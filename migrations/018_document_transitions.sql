ALTER TABLE documents ADD COLUMN wv_merged_into BIGINT REFERENCES documents(id);
ALTER TABLE documents ADD CONSTRAINT wv_no_self_merge CHECK(wv_merged_into IS DISTINCT FROM id);
CREATE INDEX wv_document_merge_target ON documents(wv_merged_into) WHERE wv_merged_into IS NOT NULL;
CREATE OR REPLACE VIEW wv_visible_documents AS SELECT * FROM documents
 WHERE wv_role_rank_v1(wv_min_role)<=(SELECT wv_actor_rank_v1())
 AND (deleted_at IS NULL OR (SELECT wv_actor_rank_v1())>=4)
 AND (wv_archived_at IS NULL OR (SELECT wv_actor_rank_v1())>=3);
CREATE VIEW wv_current_documents AS SELECT * FROM wv_visible_documents WHERE wv_merged_into IS NULL;
-- UNION, rather than UNION ALL, also terminates if legacy data contains a cycle.
CREATE VIEW wv_document_roots AS WITH RECURSIVE paths AS (
 SELECT id AS source_id,id AS target_id,wv_merged_into FROM wv_visible_documents WHERE deleted_at IS NULL AND wv_archived_at IS NULL
 UNION
 SELECT p.source_id,d.id,d.wv_merged_into FROM paths p JOIN wv_visible_documents d ON d.id=p.wv_merged_into WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL
) SELECT source_id,target_id FROM paths WHERE wv_merged_into IS NULL;
CREATE VIEW wv_resolved_names AS
 SELECT d.slug AS alias_slug,d.title AS alias_title,p.target_id AS document_id FROM wv_document_roots p JOIN wv_visible_documents d ON d.id=p.source_id
 UNION
 SELECT r.alias_slug,r.alias_title,p.target_id FROM redirects r JOIN wv_document_roots p ON p.source_id=r.document_id;
CREATE OR REPLACE VIEW wv_link_edges AS
 SELECT DISTINCT a.id AS source_id,a.slug AS source_slug,a.title AS source_title,b.id AS target_id,b.slug AS target_slug,b.title AS target_title
 FROM wv_document_links l JOIN wv_current_documents a ON a.id=l.document_id AND a.deleted_at IS NULL AND a.wv_archived_at IS NULL
 JOIN wv_resolved_names n ON n.alias_slug=l.target_slug
 JOIN wv_current_documents b ON b.id=n.document_id AND b.deleted_at IS NULL AND b.wv_archived_at IS NULL WHERE a.id<>b.id;

CREATE OR REPLACE FUNCTION wv_document_state_v1(p_id BIGINT) RETURNS JSONB LANGUAGE SQL STABLE AS $$
 SELECT jsonb_build_object('stateVersion',3,'title',d.title,'slug',d.slug,'field',d.field,'description',d.description,
 'sourceName',d.source_name,'governance',d.governance,'deletedAt',d.deleted_at,'deletedBy',d.deleted_by,'minRole',d.wv_min_role,'archivedAt',d.wv_archived_at,
 'mergedInto',d.wv_merged_into,'ownerId',d.wv_owner_id,'reviewedAt',d.wv_reviewed_at,'reviewedBy',d.wv_reviewed_by,'nextReviewOn',d.wv_next_review_on,
 'aliases',(SELECT COALESCE(jsonb_agg(jsonb_build_object('slug',alias_slug,'title',alias_title) ORDER BY alias_slug),'[]') FROM redirects WHERE document_id=d.id),
 'tags',(SELECT COALESCE(jsonb_agg(tag ORDER BY tag),'[]') FROM wv_document_tags WHERE document_id=d.id),
 'sourceIds',(SELECT COALESCE(jsonb_agg(source_id ORDER BY source_id),'[]') FROM wv_document_sources WHERE document_id=d.id)) FROM documents d WHERE d.id=p_id
$$;

ALTER FUNCTION wv_save_document_v1(JSONB) RENAME TO wv_save_document_metadata_v1;
CREATE FUNCTION wv_save_document_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF EXISTS(SELECT 1 FROM documents WHERE id=NULLIF(p->>'id','')::bigint AND wv_merged_into IS NOT NULL) THEN RAISE EXCEPTION 'document_merged'; END IF;
 RETURN wv_save_document_metadata_v1(p);
END $$;

CREATE FUNCTION wv_rename_document_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE d documents%ROWTYPE; state JSONB; names JSONB; result JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF wv_writer_rank_v1()<3 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO d FROM wv_current_documents WHERE id=(p->>'id')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL FOR UPDATE;
 IF NOT FOUND OR d.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' OR p->>'reviewed' IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 state:=wv_document_state_v1(d.id);
 names:=state->'aliases';
 IF p->>'titleSlug'<>d.slug THEN names:=names||jsonb_build_array(jsonb_build_object('title',p->>'title','slug',p->>'titleSlug')); END IF;
 SELECT COALESCE(jsonb_agg(a),'[]') INTO names FROM (SELECT DISTINCT ON(a->>'slug') a FROM jsonb_array_elements(names) a ORDER BY a->>'slug') unique_names;
 result:=wv_save_document_v1(jsonb_build_object('id',d.id,'version',d.updated_at::text,'title',p->>'title','titleSlug',p->>'titleSlug','slug',d.slug,'content',d.content,
 'editor',p->>'editor','field',d.field,'description',d.description,'sourceName',d.source_name,'aliases',names,'governance',p->'inspection',
 'summary','문서 이름 변경: '||d.title||' → '||(p->>'title'),'details',jsonb_build_object('type','rename','previousTitle',d.title,'title',p->>'title','preservedSlug',d.slug)));
 RETURN jsonb_build_object('id',d.id,'slug',d.slug);
END $$;

CREATE FUNCTION wv_merge_documents_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE source documents%ROWTYPE; target documents%ROWTYPE; source_state JSONB; target_state JSONB; result JSONB; source_revision BIGINT; target_revision BIGINT; rid BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF wv_writer_rank_v1()<3 THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF p->>'sourceId'=p->>'targetId' THEN RAISE EXCEPTION 'invalid_selection'; END IF;
 SELECT * INTO source FROM wv_current_documents WHERE id=(p->>'sourceId')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL FOR UPDATE;
 IF NOT FOUND OR source.updated_at IS DISTINCT FROM (p->>'sourceVersion')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 SELECT * INTO target FROM wv_current_documents WHERE id=(p->>'targetId')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM (p->>'targetVersion')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' OR p->>'reviewed' IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 source_state:=wv_document_state_v1(source.id); target_state:=wv_document_state_v1(target.id);
 SELECT id INTO source_revision FROM revisions WHERE document_id=source.id ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT id INTO target_revision FROM revisions WHERE document_id=target.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF wv_role_rank_v1(source.wv_min_role)>wv_role_rank_v1(target.wv_min_role) THEN UPDATE documents SET wv_min_role=source.wv_min_role WHERE id=target.id; END IF;
 result:=wv_save_document_v1(jsonb_build_object('id',target.id,'version',target.updated_at::text,'title',target.title,'slug',target.slug,'content',p->>'content',
 'editor',p->>'editor','field',target.field,'description',target.description,'sourceName',target.source_name,'aliases',target_state->'aliases','tags',p->'tags','governance',p->'inspection',
 'summary','게시 문서 병합: '||source.title||' → '||target.title,'details',jsonb_build_object('type','document_merge','sourceId',source.id,'sourceSlug',source.slug,'sourceTitle',source.title,'sourceRevisionId',source_revision,'targetPreviousRevisionId',target_revision,'note',p->>'note')));
 INSERT INTO wv_document_sources(document_id,source_id) SELECT target.id,source_id FROM wv_document_sources WHERE document_id=source.id ON CONFLICT DO NOTHING;
 SELECT id INTO rid FROM revisions WHERE document_id=target.id ORDER BY created_at DESC,id DESC LIMIT 1;
 UPDATE revisions SET document_state=wv_document_state_v1(target.id) WHERE id=rid;
 PERFORM wv_save_document_v1(jsonb_build_object('id',source.id,'version',source.updated_at::text,'title',source.title,'slug',source.slug,'content',source.content,
 'editor',p->>'editor','field',source.field,'description',source.description,'sourceName',source.source_name,'aliases',source_state->'aliases','governance',source.governance,
 'summary',target.title||'(으)로 병합 · 기존 본문과 역사 보존','details',jsonb_build_object('type','document_merge_source','targetId',target.id,'targetSlug',target.slug,'targetRevisionId',rid)));
 UPDATE documents SET wv_merged_into=target.id WHERE id=source.id;
 UPDATE revisions SET document_state=wv_document_state_v1(source.id) WHERE id=(SELECT id FROM revisions WHERE document_id=source.id ORDER BY created_at DESC,id DESC LIMIT 1);
 RETURN jsonb_build_object('id',target.id,'slug',target.slug,'revisionId',rid);
END $$;

-- Resolve inherited source titles and aliases to the current merged document.
CREATE OR REPLACE FUNCTION wv_search_documents_v1(p JSONB) RETURNS JSONB LANGUAGE SQL STABLE AS $$
WITH terms AS (SELECT value AS term FROM jsonb_array_elements_text(COALESCE(p->'terms','[]'::jsonb))),
base AS (
 SELECT d.id,d.slug,d.title,d.field,d.editor_handle,d.updated_at,d.source_name,
 COALESCE(d.governance->>'reviewState','needs_review') AS state,
 COALESCE((SELECT jsonb_agg(tag ORDER BY tag) FROM wv_document_tags t WHERE t.document_id=d.id),'[]'::jsonb) AS tags,
 CASE WHEN wv_normalize_v1(d.title)=p->>'normalized' THEN 1000
 WHEN EXISTS(SELECT 1 FROM wv_resolved_names r WHERE r.document_id=d.id AND wv_normalize_v1(r.alias_title)=p->>'normalized') THEN 900 ELSE 0 END
 + COALESCE((SELECT sum(CASE WHEN position(term IN wv_normalize_v1(d.title))>0 THEN 30
 WHEN EXISTS(SELECT 1 FROM wv_resolved_names r WHERE r.document_id=d.id AND position(term IN wv_normalize_v1(r.alias_title))>0) THEN 20 ELSE 1 END) FROM terms),0) AS score,
 CASE WHEN COALESCE(p->>'q','')='' THEN COALESCE(NULLIF(d.description,''),left(d.content,240))
 ELSE substring(d.content FROM greatest(1,COALESCE((SELECT min(NULLIF(position(lower(term) IN lower(d.content)),0)) FROM terms),1)-80) FOR 320) END AS snippet
 FROM wv_current_documents d WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM terms WHERE position(term IN d.wv_search_text)=0
 AND NOT EXISTS(SELECT 1 FROM wv_resolved_names r WHERE r.document_id=d.id AND position(term IN wv_normalize_v1(r.alias_title))>0))
 AND (COALESCE(p->>'state','')='' OR COALESCE(d.governance->>'reviewState','needs_review')=p->>'state')
 AND (COALESCE(p->>'tag','')='' OR EXISTS(SELECT 1 FROM wv_document_tags t WHERE t.document_id=d.id AND t.tag=p->>'tag'))
 AND (COALESCE(p->>'days','')='' OR d.updated_at>=NOW()-make_interval(days=>(p->>'days')::integer))
), filtered AS (SELECT * FROM base WHERE COALESCE(p->>'field','')='' OR field=p->>'field'),
page AS (SELECT * FROM filtered ORDER BY CASE WHEN p->>'sort'='recent' THEN 0 ELSE score END DESC,updated_at DESC,id DESC
 LIMIT LEAST(40,GREATEST(1,COALESCE((p->>'limit')::integer,20))) OFFSET GREATEST(0,COALESCE((p->>'page')::integer,1)-1)*LEAST(40,GREATEST(1,COALESCE((p->>'limit')::integer,20)))),
summary AS (SELECT page.*,(SELECT count(*) FROM wv_link_edges e WHERE e.target_id=page.id) AS backlink_count,
 (SELECT id FROM revisions r WHERE r.document_id=page.id ORDER BY created_at DESC,id DESC LIMIT 1) AS revision_id FROM page)
SELECT jsonb_build_object('results',COALESCE((SELECT jsonb_agg(to_jsonb(summary)) FROM summary),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),
 'facets',COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM (SELECT field AS name,count(*) AS count FROM base GROUP BY field ORDER BY field) f),'[]'::jsonb))
$$;
