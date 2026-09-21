ALTER TABLE documents ADD COLUMN wv_owner_id BIGINT REFERENCES wv_users(id);
ALTER TABLE documents ADD COLUMN wv_reviewed_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN wv_reviewed_by BIGINT REFERENCES wv_users(id);
ALTER TABLE documents ADD COLUMN wv_next_review_on DATE;
CREATE INDEX wv_document_review_due ON documents(wv_next_review_on) WHERE deleted_at IS NULL AND wv_archived_at IS NULL;
CREATE TABLE wv_reviews (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_id BIGINT NOT NULL REFERENCES revisions(id),
  reviewer_id BIGINT NOT NULL REFERENCES wv_users(id),
  note TEXT NOT NULL DEFAULT '',
  next_review_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Refresh the read view to expose the additive metadata columns.
CREATE OR REPLACE VIEW wv_visible_documents AS SELECT * FROM documents
 WHERE wv_role_rank_v1(wv_min_role)<=(SELECT wv_actor_rank_v1())
 AND (deleted_at IS NULL OR (SELECT wv_actor_rank_v1())>=4)
 AND (wv_archived_at IS NULL OR (SELECT wv_actor_rank_v1())>=3);
CREATE FUNCTION wv_document_state_v1(p_id BIGINT) RETURNS JSONB LANGUAGE SQL STABLE AS $$
 SELECT jsonb_build_object('stateVersion',2,'title',d.title,'slug',d.slug,'field',d.field,'description',d.description,
 'sourceName',d.source_name,'governance',d.governance,'deletedAt',d.deleted_at,'minRole',d.wv_min_role,'archivedAt',d.wv_archived_at,
 'ownerId',d.wv_owner_id,'reviewedAt',d.wv_reviewed_at,'reviewedBy',d.wv_reviewed_by,'nextReviewOn',d.wv_next_review_on,
 'aliases',(SELECT COALESCE(jsonb_agg(jsonb_build_object('slug',alias_slug,'title',alias_title) ORDER BY alias_slug),'[]') FROM redirects WHERE document_id=d.id),
 'tags',(SELECT COALESCE(jsonb_agg(tag ORDER BY tag),'[]') FROM wv_document_tags WHERE document_id=d.id),
 'sourceIds',(SELECT COALESCE(jsonb_agg(source_id ORDER BY source_id),'[]') FROM wv_document_sources WHERE document_id=d.id)) FROM documents d WHERE d.id=p_id
$$;
CREATE FUNCTION wv_snapshot_revision_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.document_state:=wv_document_state_v1(NEW.document_id); RETURN NEW; END $$;
CREATE TRIGGER wv_revision_snapshot BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION wv_snapshot_revision_v1();
CREATE FUNCTION wv_snapshot_publication_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id BIGINT;
BEGIN
 target_id:=COALESCE((NEW.governance->>'publishedDocumentId')::bigint,(NEW.governance->'mergedInto'->>'id')::bigint);
 UPDATE revisions SET document_state=wv_document_state_v1(target_id) WHERE id=(SELECT id FROM revisions WHERE document_id=target_id ORDER BY created_at DESC,id DESC LIMIT 1);
 RETURN NEW;
END $$;
CREATE TRIGGER wv_publish_snapshot AFTER UPDATE OF status ON drafts FOR EACH ROW WHEN(NEW.status='published' AND OLD.status<>'published') EXECUTE FUNCTION wv_snapshot_publication_v1();

CREATE FUNCTION wv_manage_document_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE d documents%ROWTYPE; result JSONB; actor BIGINT; state JSONB; action TEXT; rid BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 action:=p->>'action';
 IF actor IS NULL OR wv_writer_rank_v1()<3 OR (action='access' AND wv_actor_rank_v1()<4) THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO d FROM wv_visible_documents WHERE id=(p->>'id')::bigint AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR d.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF action NOT IN('review','ownership','archive','access') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 IF action='review' AND (p->'inspection'->>'passed' IS DISTINCT FROM 'true' OR p->>'reviewed' IS DISTINCT FROM 'yes') THEN RAISE EXCEPTION 'content_blocked'; END IF;
 IF action IN('review','ownership') AND NULLIF(p->>'ownerId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wv_users WHERE id=(p->>'ownerId')::bigint AND active AND role IN('editor','reviewer','admin')) THEN RAISE EXCEPTION 'invalid_account'; END IF;
 state:=wv_document_state_v1(d.id);
 result:=wv_save_document_v1(jsonb_build_object('id',d.id,'version',d.updated_at::text,'title',d.title,'slug',d.slug,'content',d.content,
 'field',d.field,'description',d.description,'sourceName',d.source_name,'editor',p->>'editor','aliases',state->'aliases',
 'summary',CASE action WHEN 'review' THEN '문서 검토 기록' WHEN 'ownership' THEN '담당자·검토 기한 변경' WHEN 'archive' THEN '보관 상태 변경' ELSE '읽기 권한 변경' END,
 'governance',d.governance,'details',jsonb_build_object('type','document_management','action',action,'note',p->>'note')));
 IF action='access' THEN
   UPDATE documents SET wv_min_role=p->>'minRole' WHERE id=d.id;
 ELSIF action='archive' THEN
   UPDATE documents SET wv_archived_at=CASE WHEN p->>'archived'='yes' THEN clock_timestamp() ELSE NULL END,
    governance=governance||jsonb_build_object('reviewState',CASE WHEN p->>'archived'='yes' THEN 'archived' WHEN d.governance->>'reviewState'='example' THEN 'example' ELSE 'needs_review' END) WHERE id=d.id;
 ELSE
   UPDATE documents SET wv_owner_id=NULLIF(p->>'ownerId','')::bigint,wv_next_review_on=NULLIF(p->>'nextReviewOn','')::date,
    wv_reviewed_at=CASE WHEN action='review' THEN clock_timestamp() ELSE wv_reviewed_at END,
    wv_reviewed_by=CASE WHEN action='review' THEN actor ELSE wv_reviewed_by END,
    governance=CASE WHEN action='review' THEN governance||jsonb_build_object('reviewState',CASE WHEN d.governance->>'reviewState'='example' THEN 'example' ELSE 'reviewed' END) ELSE d.governance END WHERE id=d.id;
 END IF;
 SELECT id INTO rid FROM revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1;
 UPDATE revisions SET document_state=wv_document_state_v1(d.id) WHERE id=rid;
 IF action='review' THEN INSERT INTO wv_reviews(document_id,revision_id,reviewer_id,note,next_review_on) VALUES(d.id,rid,actor,COALESCE(p->>'note',''),NULLIF(p->>'nextReviewOn','')::date); END IF;
 RETURN jsonb_build_object('id',d.id,'slug',d.slug);
END $$;
