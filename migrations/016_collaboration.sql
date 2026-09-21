ALTER TABLE discussions ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved'));
ALTER TABLE discussions ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE discussions ADD COLUMN paragraph_anchor TEXT NOT NULL DEFAULT '';
ALTER TABLE discussions ADD COLUMN resolution_revision_id BIGINT REFERENCES revisions(id);
ALTER TABLE discussions ADD COLUMN target_revision_id BIGINT REFERENCES revisions(id);
CREATE TABLE wv_replies (
 id BIGSERIAL PRIMARY KEY,
 discussion_id BIGINT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
 actor_id BIGINT NOT NULL REFERENCES wv_users(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX wv_replies_thread ON wv_replies(discussion_id,created_at,id);
CREATE TABLE wv_proposals (
 id BIGSERIAL PRIMARY KEY,
 document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 proposer_id BIGINT NOT NULL REFERENCES wv_users(id),
 discussion_id BIGINT REFERENCES discussions(id),
 base_version TEXT NOT NULL,
 base_revision_id BIGINT NOT NULL REFERENCES revisions(id),
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 200000),
 summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','accepted','rejected')),
 decision_actor_id BIGINT REFERENCES wv_users(id),
 decision_revision_id BIGINT REFERENCES revisions(id),
 decision_note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wv_notifications ADD COLUMN proposal_id BIGINT REFERENCES wv_proposals(id);
ALTER TABLE wv_notifications ADD COLUMN discussion_id BIGINT REFERENCES discussions(id);
CREATE INDEX wv_proposals_document ON wv_proposals(document_id,created_at DESC);

CREATE FUNCTION wv_create_proposal_v1(p JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; d documents%ROWTYPE; result BIGINT; base_id BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO d FROM wv_visible_documents WHERE id=(p->>'documentId')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL FOR UPDATE;
 IF NOT FOUND OR d.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 IF NULLIF(p->>'discussionId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM discussions WHERE id=(p->>'discussionId')::bigint AND document_id=d.id) THEN RAISE EXCEPTION 'invalid_discussion'; END IF;
 SELECT id INTO base_id FROM revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1;
 INSERT INTO wv_proposals(document_id,proposer_id,discussion_id,base_version,base_revision_id,content,summary)
 VALUES(d.id,actor,NULLIF(p->>'discussionId','')::bigint,d.updated_at::text,base_id,p->>'content',p->>'summary') RETURNING id INTO result;
 INSERT INTO wv_notifications(user_id,document_id,kind,event_key,actor_id,proposal_id)
 SELECT id,d.id,'proposal_review','proposal:'||result,actor,result FROM wv_users WHERE active AND wv_role_rank_v1(role)>=GREATEST(3,wv_role_rank_v1(d.wv_min_role)) AND id<>actor ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
CREATE FUNCTION wv_decide_proposal_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; proposal wv_proposals%ROWTYPE; d documents%ROWTYPE; saved JSONB; rid BIGINT; state JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<3 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO proposal FROM wv_proposals WHERE id=(p->>'id')::bigint FOR UPDATE;
 IF NOT FOUND OR proposal.status<>'open' OR proposal.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 SELECT * INTO d FROM wv_visible_documents WHERE id=proposal.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'document_missing'; END IF;
 IF p->>'decision' NOT IN('accepted','rejected') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 IF p->>'decision'='accepted' THEN
   IF d.updated_at<>proposal.base_version::timestamptz OR p->>'reviewed' IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'version_conflict'; END IF;
   state:=wv_document_state_v1(d.id);
   saved:=wv_save_document_v1(jsonb_build_object('id',d.id,'version',d.updated_at::text,'title',d.title,'slug',d.slug,'content',p->>'content','editor',p->>'editor',
    'field',d.field,'description',d.description,'sourceName',d.source_name,'aliases',state->'aliases','governance',p->'inspection',
    'summary','수정 제안 #'||proposal.id||' 승인 · '||proposal.summary,
    'details',jsonb_build_object('type','proposal','proposalId',proposal.id,'proposerId',proposal.proposer_id,'manuallyEdited',proposal.content IS DISTINCT FROM p->>'content')));
   SELECT id INTO rid FROM revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1;
   IF proposal.discussion_id IS NOT NULL AND p->>'resolveThread'='yes' THEN
     UPDATE discussions SET status='resolved',resolution_revision_id=rid,updated_at=clock_timestamp() WHERE id=proposal.discussion_id AND document_id=d.id;
   END IF;
 END IF;
 UPDATE wv_proposals SET status=p->>'decision',decision_actor_id=actor,decision_revision_id=rid,decision_note=COALESCE(p->>'note',''),updated_at=clock_timestamp() WHERE id=proposal.id;
 INSERT INTO wv_notifications(user_id,document_id,revision_id,kind,event_key,actor_id,proposal_id)
 VALUES(proposal.proposer_id,d.id,rid,'proposal_result','proposal-result:'||proposal.id,actor,proposal.id) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('slug',d.slug,'revisionId',rid);
END $$;
CREATE FUNCTION wv_reply_v1(p JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; thread discussions%ROWTYPE; result BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO thread FROM discussions WHERE id=(p->>'threadId')::bigint FOR UPDATE;
 IF thread.status<>'open' THEN RAISE EXCEPTION 'discussion_resolved'; END IF;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=thread.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'document_missing'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 INSERT INTO wv_replies(discussion_id,actor_id,body) VALUES(thread.id,actor,p->>'body') RETURNING id INTO result;
 UPDATE discussions SET updated_at=clock_timestamp() WHERE id=thread.id;
 INSERT INTO wv_notifications(user_id,document_id,kind,event_key,actor_id,discussion_id)
 SELECT member,thread.document_id,'discussion_reply','reply:'||result,actor,thread.id FROM (
  SELECT thread.actor_id AS member UNION SELECT actor_id FROM wv_replies WHERE discussion_id=thread.id UNION SELECT user_id FROM wv_user_documents WHERE document_id=thread.document_id AND subscribed
 ) members WHERE member IS NOT NULL AND member<>actor ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
CREATE FUNCTION wv_resolve_discussion_v1(p JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; thread discussions%ROWTYPE; rank INTEGER; rid BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint; rank:=wv_writer_rank_v1();
 SELECT * INTO thread FROM discussions WHERE id=(p->>'id')::bigint FOR UPDATE;
 IF actor IS NULL OR rank<1 OR NOT FOUND OR (thread.actor_id IS DISTINCT FROM actor AND rank<3) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF thread.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=thread.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'document_missing'; END IF;
 IF p->>'status' NOT IN('open','resolved') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 rid:=NULLIF(p->>'revisionId','')::bigint;
 IF rid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM revisions WHERE id=rid AND document_id=thread.document_id) THEN RAISE EXCEPTION 'invalid_revision'; END IF;
 UPDATE discussions SET status=p->>'status',resolution_revision_id=CASE WHEN p->>'status'='resolved' THEN rid END,updated_at=clock_timestamp() WHERE id=thread.id;
END $$;

CREATE FUNCTION wv_guard_discussion_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF wv_writer_rank_v1()<1 OR NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=NEW.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'forbidden'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wv_discussion_guard BEFORE INSERT OR UPDATE ON discussions FOR EACH ROW EXECUTE FUNCTION wv_guard_discussion_v1();
