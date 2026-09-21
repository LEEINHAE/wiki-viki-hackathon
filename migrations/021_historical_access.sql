-- Current access can become broader without publishing older restricted text.
CREATE VIEW wv_visible_revisions AS SELECT r.* FROM revisions r
 WHERE EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=r.document_id)
 AND wv_role_rank_v1(COALESCE(r.document_state->>'minRole','reader'))<=(SELECT wv_actor_rank_v1());
ALTER TABLE discussions ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
ALTER TABLE wv_replies ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
ALTER TABLE wv_proposals ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
ALTER TABLE wv_reviews ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
CREATE OR REPLACE FUNCTION wv_guard_discussion_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('wv.operator',true)='1' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF wv_writer_rank_v1()<GREATEST(1,wv_role_rank_v1(NEW.wv_min_role)) OR NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=NEW.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'forbidden'; END IF;
 RETURN NEW;
END $$;
UPDATE discussions t SET wv_min_role=(SELECT scope FROM (SELECT wv_min_role AS scope FROM documents WHERE id=t.document_id UNION ALL SELECT document_state->>'minRole' FROM revisions WHERE id=t.target_revision_id) scopes WHERE scope IS NOT NULL ORDER BY wv_role_rank_v1(scope) DESC LIMIT 1);
UPDATE wv_replies r SET wv_min_role=t.wv_min_role FROM discussions t WHERE t.id=r.discussion_id;
UPDATE wv_proposals p SET wv_min_role=(SELECT scope FROM (SELECT wv_min_role AS scope FROM documents WHERE id=p.document_id UNION ALL SELECT document_state->>'minRole' FROM revisions WHERE id=p.base_revision_id) scopes WHERE scope IS NOT NULL ORDER BY wv_role_rank_v1(scope) DESC LIMIT 1);
UPDATE wv_reviews r SET wv_min_role=(SELECT scope FROM (SELECT wv_min_role AS scope FROM documents WHERE id=r.document_id UNION ALL SELECT document_state->>'minRole' FROM revisions WHERE id=r.revision_id) scopes WHERE scope IS NOT NULL ORDER BY wv_role_rank_v1(scope) DESC LIMIT 1);
CREATE VIEW wv_visible_discussions AS SELECT t.* FROM discussions t WHERE wv_role_rank_v1(t.wv_min_role)<=(SELECT wv_actor_rank_v1()) AND EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=t.document_id);
CREATE VIEW wv_visible_replies AS SELECT r.* FROM wv_replies r WHERE wv_role_rank_v1(r.wv_min_role)<=(SELECT wv_actor_rank_v1()) AND EXISTS(SELECT 1 FROM wv_visible_discussions t WHERE t.id=r.discussion_id);
CREATE VIEW wv_visible_proposals AS SELECT p.* FROM wv_proposals p WHERE wv_role_rank_v1(p.wv_min_role)<=(SELECT wv_actor_rank_v1()) AND EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=p.document_id);
CREATE VIEW wv_visible_reviews AS SELECT r.* FROM wv_reviews r WHERE wv_role_rank_v1(r.wv_min_role)<=(SELECT wv_actor_rank_v1()) AND EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=r.document_id);
CREATE FUNCTION wv_record_content_access_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE minimum TEXT; revision_id BIGINT; historical TEXT;
BEGIN
 IF TG_TABLE_NAME='wv_replies' THEN
  SELECT CASE WHEN wv_role_rank_v1(t.wv_min_role)>wv_role_rank_v1(d.wv_min_role) THEN t.wv_min_role ELSE d.wv_min_role END INTO minimum FROM discussions t JOIN documents d ON d.id=t.document_id WHERE t.id=NEW.discussion_id;
 ELSE
  SELECT wv_min_role INTO minimum FROM documents WHERE id=NEW.document_id;
  IF TG_TABLE_NAME='discussions' THEN revision_id:=NEW.target_revision_id;
  ELSIF TG_TABLE_NAME='wv_proposals' THEN revision_id:=NEW.base_revision_id;
  ELSE revision_id:=NEW.revision_id; END IF;
  SELECT document_state->>'minRole' INTO historical FROM revisions WHERE id=revision_id;
  IF wv_role_rank_v1(historical)>wv_role_rank_v1(minimum) THEN minimum:=historical; END IF;
 END IF;
 NEW.wv_min_role:=minimum;
 IF wv_writer_rank_v1()<wv_role_rank_v1(minimum) THEN RAISE EXCEPTION 'forbidden'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wv_discussion_access BEFORE INSERT ON discussions FOR EACH ROW EXECUTE FUNCTION wv_record_content_access_v1();
CREATE TRIGGER wv_reply_access BEFORE INSERT ON wv_replies FOR EACH ROW EXECUTE FUNCTION wv_record_content_access_v1();
CREATE TRIGGER wv_proposal_access BEFORE INSERT ON wv_proposals FOR EACH ROW EXECUTE FUNCTION wv_record_content_access_v1();
CREATE TRIGGER wv_review_access BEFORE INSERT ON wv_reviews FOR EACH ROW EXECUTE FUNCTION wv_record_content_access_v1();

CREATE OR REPLACE FUNCTION wv_create_proposal_v1(p JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; d documents%ROWTYPE; result BIGINT; base_id BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO d FROM wv_visible_documents WHERE id=(p->>'documentId')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL FOR UPDATE;
 IF NOT FOUND OR d.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 IF NULLIF(p->>'discussionId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wv_visible_discussions WHERE id=(p->>'discussionId')::bigint AND document_id=d.id) THEN RAISE EXCEPTION 'invalid_discussion'; END IF;
 SELECT id INTO base_id FROM wv_visible_revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1;
 INSERT INTO wv_proposals(document_id,proposer_id,discussion_id,base_version,base_revision_id,content,summary)
 VALUES(d.id,actor,NULLIF(p->>'discussionId','')::bigint,d.updated_at::text,base_id,p->>'content',p->>'summary') RETURNING id INTO result;
 INSERT INTO wv_notifications(user_id,document_id,kind,event_key,actor_id,proposal_id)
 SELECT id,d.id,'proposal_review','proposal:'||result,actor,result FROM wv_users WHERE active AND wv_role_rank_v1(role)>=GREATEST(3,wv_role_rank_v1(d.wv_min_role)) AND id<>actor ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION wv_decide_proposal_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; proposal wv_proposals%ROWTYPE; d documents%ROWTYPE; saved JSONB; rid BIGINT; state JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<3 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO proposal FROM wv_visible_proposals WHERE id=(p->>'id')::bigint FOR UPDATE;
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
   SELECT id INTO rid FROM wv_visible_revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1;
   IF proposal.discussion_id IS NOT NULL AND p->>'resolveThread'='yes' THEN
     UPDATE discussions SET status='resolved',resolution_revision_id=rid,updated_at=clock_timestamp() WHERE id=proposal.discussion_id AND document_id=d.id;
   END IF;
 END IF;
 UPDATE wv_proposals SET status=p->>'decision',decision_actor_id=actor,decision_revision_id=rid,decision_note=COALESCE(p->>'note',''),updated_at=clock_timestamp() WHERE id=proposal.id;
 INSERT INTO wv_notifications(user_id,document_id,revision_id,kind,event_key,actor_id,proposal_id)
 VALUES(proposal.proposer_id,d.id,rid,'proposal_result','proposal-result:'||proposal.id,actor,proposal.id) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('slug',d.slug,'revisionId',rid);
END $$;
CREATE OR REPLACE FUNCTION wv_reply_v1(p JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; thread discussions%ROWTYPE; result BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO thread FROM wv_visible_discussions WHERE id=(p->>'threadId')::bigint FOR UPDATE;
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
CREATE OR REPLACE FUNCTION wv_resolve_discussion_v1(p JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; thread discussions%ROWTYPE; rank INTEGER; rid BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(21470921,2);
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint; rank:=wv_writer_rank_v1();
 SELECT * INTO thread FROM wv_visible_discussions WHERE id=(p->>'id')::bigint FOR UPDATE;
 IF actor IS NULL OR rank<1 OR NOT FOUND OR (thread.actor_id IS DISTINCT FROM actor AND rank<3) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF thread.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
 IF NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=thread.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'document_missing'; END IF;
 IF p->>'status' NOT IN('open','resolved') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 rid:=NULLIF(p->>'revisionId','')::bigint;
 IF rid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wv_visible_revisions WHERE id=rid AND document_id=thread.document_id) THEN RAISE EXCEPTION 'invalid_revision'; END IF;
 UPDATE discussions SET status=p->>'status',resolution_revision_id=CASE WHEN p->>'status'='resolved' THEN rid END,updated_at=clock_timestamp() WHERE id=thread.id;
END $$;

CREATE OR REPLACE FUNCTION wv_guard_discussion_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('wv.operator',true)='1' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(21470921,2);
 IF wv_writer_rank_v1()<GREATEST(1,wv_role_rank_v1(NEW.wv_min_role)) OR NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=NEW.document_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'forbidden'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE wv_notifications ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
CREATE FUNCTION wv_notification_access_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 SELECT scope INTO NEW.wv_min_role FROM (
  SELECT wv_min_role AS scope FROM documents WHERE id=NEW.document_id
  UNION ALL SELECT document_state->>'minRole' FROM revisions WHERE id=NEW.revision_id
  UNION ALL SELECT wv_min_role FROM wv_proposals WHERE id=NEW.proposal_id
  UNION ALL SELECT wv_min_role FROM discussions WHERE id=NEW.discussion_id
 ) scopes WHERE scope IS NOT NULL ORDER BY wv_role_rank_v1(scope) DESC LIMIT 1;
 RETURN NEW;
END $$;
CREATE TRIGGER wv_notification_access BEFORE INSERT ON wv_notifications FOR EACH ROW EXECUTE FUNCTION wv_notification_access_v1();
UPDATE wv_notifications n SET wv_min_role=(SELECT scope FROM (
 SELECT wv_min_role AS scope FROM documents WHERE id=n.document_id
 UNION ALL SELECT document_state->>'minRole' FROM revisions WHERE id=n.revision_id
 UNION ALL SELECT wv_min_role FROM wv_proposals WHERE id=n.proposal_id
 UNION ALL SELECT wv_min_role FROM discussions WHERE id=n.discussion_id
) scopes WHERE scope IS NOT NULL ORDER BY wv_role_rank_v1(scope) DESC LIMIT 1);
