CREATE TABLE wv_search_events (
 id BIGSERIAL PRIMARY KEY,
 query TEXT NOT NULL CHECK(length(query) BETWEEN 2 AND 80),
 query_key TEXT NOT NULL CHECK(length(query_key) BETWEEN 2 AND 80),
 visitor_hash TEXT NOT NULL CHECK(visitor_hash ~ '^[a-f0-9]{64}$'),
 bucket_start TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 min_role TEXT NOT NULL CHECK(min_role IN('reader','editor','reviewer','admin')),
 UNIQUE(visitor_hash,query_key,bucket_start)
);
CREATE INDEX wv_search_events_recent ON wv_search_events(created_at DESC);
CREATE FUNCTION wv_record_search_v1(p JSONB) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE target documents%ROWTYPE; bucket TIMESTAMPTZ; actor TEXT;
BEGIN
 IF wv_actor_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO target FROM wv_current_documents WHERE id=(p->>'documentId')::bigint AND deleted_at IS NULL AND wv_archived_at IS NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 bucket:=to_timestamp(floor(extract(epoch FROM NOW())/300)*300);
 PERFORM pg_advisory_xact_lock(hashtextextended('search:'||(p->>'visitor'),0));
 DELETE FROM wv_search_events WHERE created_at<NOW()-interval '1 hour';
 IF (SELECT count(*) FROM wv_search_events WHERE visitor_hash=p->>'visitor' AND bucket_start=bucket)>=20 THEN RETURN false; END IF;
 actor:=current_setting('wv.actor_role',true);
 INSERT INTO wv_search_events(query,query_key,visitor_hash,bucket_start,document_id,min_role)
 VALUES(p->>'query',p->>'key',p->>'visitor',bucket,target.id,
 CASE WHEN actor IN('reader','editor','reviewer','admin') AND wv_role_rank_v1(actor)>wv_role_rank_v1(target.wv_min_role) THEN actor ELSE target.wv_min_role END)
 ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $$;
CREATE FUNCTION wv_search_trending_v1() RETURNS TABLE(query TEXT,count BIGINT) LANGUAGE SQL STABLE AS $$
 SELECT (array_agg(e.query ORDER BY e.created_at DESC,e.id DESC))[1], count(*)
 FROM wv_search_events e JOIN wv_current_documents d ON d.id=e.document_id
 WHERE e.created_at>=NOW()-interval '1 hour' AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL
 AND wv_role_rank_v1(e.min_role)<=(SELECT wv_actor_rank_v1())
 GROUP BY e.query_key ORDER BY count(*) DESC,max(e.created_at) DESC,e.query_key LIMIT 10
$$;
