CREATE TABLE wv_user_documents (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES wv_users(id) ON DELETE CASCADE,
 document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 favorite BOOLEAN NOT NULL DEFAULT false,
 subscribed BOOLEAN NOT NULL DEFAULT false,
 viewed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,document_id)
);
CREATE INDEX wv_user_recent ON wv_user_documents(user_id,viewed_at DESC);
CREATE TABLE wv_notifications (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES wv_users(id) ON DELETE CASCADE,
 document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 revision_id BIGINT REFERENCES revisions(id),
 kind TEXT NOT NULL,
 event_key TEXT NOT NULL,
 actor_id BIGINT REFERENCES wv_users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 read_at TIMESTAMPTZ,
 UNIQUE(user_id,event_key)
);
CREATE INDEX wv_notifications_inbox ON wv_notifications(user_id,created_at DESC);
CREATE FUNCTION wv_personal_document_v1(p_id BIGINT,p_action TEXT,p_value BOOLEAN DEFAULT false) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actor BIGINT;
BEGIN
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wiki-personal:'||actor,0));
 IF NOT EXISTS(SELECT 1 FROM wv_visible_documents WHERE id=p_id AND deleted_at IS NULL AND wv_archived_at IS NULL) THEN RAISE EXCEPTION 'document_missing'; END IF;
 IF p_action NOT IN('visit','favorite','subscribe') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 IF p_action='favorite' AND p_value AND NOT EXISTS(SELECT 1 FROM wv_user_documents WHERE user_id=actor AND document_id=p_id AND favorite)
   AND (SELECT count(*) FROM wv_user_documents WHERE user_id=actor AND favorite)>=100 THEN RAISE EXCEPTION 'favorite_limit'; END IF;
 IF p_action='subscribe' AND p_value AND NOT EXISTS(SELECT 1 FROM wv_user_documents WHERE user_id=actor AND document_id=p_id AND subscribed)
   AND (SELECT count(*) FROM wv_user_documents WHERE user_id=actor AND subscribed)>=100 THEN RAISE EXCEPTION 'subscription_limit'; END IF;
 INSERT INTO wv_user_documents(user_id,document_id,favorite,subscribed,viewed_at)
 VALUES(actor,p_id,p_action='favorite' AND p_value,p_action='subscribe' AND p_value,CASE WHEN p_action='visit' THEN clock_timestamp() END)
 ON CONFLICT(user_id,document_id) DO UPDATE SET
  favorite=CASE WHEN p_action='favorite' THEN p_value ELSE wv_user_documents.favorite END,
  subscribed=CASE WHEN p_action='subscribe' THEN p_value ELSE wv_user_documents.subscribed END,
  viewed_at=CASE WHEN p_action='visit' THEN clock_timestamp() ELSE wv_user_documents.viewed_at END;
 UPDATE wv_user_documents SET viewed_at=NULL WHERE user_id=actor AND viewed_at IS NOT NULL AND (viewed_at<NOW()-interval '30 days' OR id IN(SELECT id FROM wv_user_documents WHERE user_id=actor AND viewed_at IS NOT NULL ORDER BY viewed_at DESC,id DESC OFFSET 30));
 DELETE FROM wv_user_documents WHERE user_id=actor AND NOT favorite AND NOT subscribed AND viewed_at IS NULL;
END $$;
CREATE FUNCTION wv_notify_revision_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO wv_notifications(user_id,document_id,revision_id,kind,event_key,actor_id)
 SELECT u.user_id,NEW.document_id,NEW.id,'document_changed','revision:'||NEW.id,NEW.actor_id
 FROM wv_user_documents u JOIN wv_users a ON a.id=u.user_id AND a.active
 WHERE u.document_id=NEW.document_id AND u.subscribed AND u.user_id IS DISTINCT FROM NEW.actor_id ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER wv_revision_notifications AFTER INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION wv_notify_revision_v1();
CREATE FUNCTION wv_notify_owner_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO wv_notifications(user_id,document_id,kind,event_key,actor_id)
 VALUES(NEW.wv_owner_id,NEW.id,'review_requested','owner:'||NEW.id||':'||NEW.updated_at::text,NULLIF(current_setting('wv.actor_id',true),'')::bigint) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER wv_owner_notification AFTER UPDATE OF wv_owner_id ON documents FOR EACH ROW WHEN(NEW.wv_owner_id IS NOT NULL AND OLD.wv_owner_id IS DISTINCT FROM NEW.wv_owner_id) EXECUTE FUNCTION wv_notify_owner_v1();
