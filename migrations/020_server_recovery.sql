CREATE TABLE wv_recoveries (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES wv_users(id) ON DELETE CASCADE,
 recovery_key TEXT NOT NULL CHECK(length(recovery_key) BETWEEN 1 AND 240),
 kind TEXT NOT NULL CHECK(kind IN('new_document','document','draft','proposal','discussion','document_merge')),
 resources JSONB NOT NULL,
 input_values JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+interval '24 hours',
 UNIQUE(user_id,recovery_key)
);
CREATE INDEX wv_recovery_expiry ON wv_recoveries(expires_at);
CREATE FUNCTION wv_recovery_access_v1(p_kind TEXT,p_resources JSONB) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT jsonb_typeof(p_resources)='array' AND jsonb_array_length(p_resources)<=2
 AND (SELECT wv_actor_rank_v1())>=CASE p_kind WHEN 'new_document' THEN 2 WHEN 'document' THEN 2 WHEN 'draft' THEN 2 WHEN 'proposal' THEN 1 WHEN 'discussion' THEN 1 WHEN 'document_merge' THEN 3 ELSE 5 END
 AND (CASE WHEN p_kind='new_document' THEN jsonb_array_length(p_resources)=0 WHEN p_kind='document_merge' THEN jsonb_array_length(p_resources)=2 ELSE jsonb_array_length(p_resources)=1 END)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_resources) r WHERE
  CASE WHEN p_kind='draft' THEN r->>'type' IS DISTINCT FROM 'draft' OR NOT EXISTS(SELECT 1 FROM wv_visible_drafts WHERE id=(r->>'id')::bigint AND status<>'published')
  ELSE r->>'type' IS DISTINCT FROM 'document' OR NOT EXISTS(SELECT 1 FROM wv_current_documents WHERE id=(r->>'id')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL) END)
$$;
CREATE FUNCTION wv_save_recovery_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; previous wv_recoveries%ROWTYPE; stored wv_recoveries%ROWTYPE;
BEGIN
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wiki-recovery:'||actor,0));
 DELETE FROM wv_recoveries WHERE expires_at<NOW();
 SELECT * INTO previous FROM wv_recoveries WHERE user_id=actor AND recovery_key=p->>'key' FOR UPDATE;
 IF FOUND AND previous.updated_at IS DISTINCT FROM NULLIF(p->>'version','')::timestamptz THEN RAISE EXCEPTION 'recovery_conflict'; END IF;
 IF p->>'action'='delete' THEN
  DELETE FROM wv_recoveries WHERE user_id=actor AND recovery_key=p->>'key';
  RETURN jsonb_build_object('version',NULL);
 END IF;
 IF wv_recovery_access_v1(p->>'kind',p->'resources') IS DISTINCT FROM true THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF NOT EXISTS(SELECT 1 FROM wv_recoveries WHERE user_id=actor AND recovery_key=p->>'key') AND (SELECT count(*) FROM wv_recoveries WHERE user_id=actor)>=20 THEN RAISE EXCEPTION 'recovery_limit'; END IF;
 INSERT INTO wv_recoveries(user_id,recovery_key,kind,resources,input_values) VALUES(actor,p->>'key',p->>'kind',p->'resources',p->'values')
 ON CONFLICT(user_id,recovery_key) DO UPDATE SET kind=EXCLUDED.kind,resources=EXCLUDED.resources,input_values=EXCLUDED.input_values,updated_at=GREATEST(clock_timestamp(),wv_recoveries.updated_at+interval '1 microsecond'),expires_at=clock_timestamp()+interval '24 hours' RETURNING * INTO stored;
 RETURN jsonb_build_object('version',stored.updated_at::text,'expires',extract(epoch FROM stored.expires_at)*1000);
END $$;
