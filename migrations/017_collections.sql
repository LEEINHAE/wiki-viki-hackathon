CREATE TABLE wv_collections (
 id BIGSERIAL PRIMARY KEY,
 owner_id BIGINT NOT NULL REFERENCES wv_users(id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 shared BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(owner_id,title)
);
CREATE TABLE wv_collection_items (
 id BIGSERIAL PRIMARY KEY,
 collection_id BIGINT NOT NULL REFERENCES wv_collections(id) ON DELETE CASCADE,
 document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(collection_id,position),UNIQUE(collection_id,document_id)
);
CREATE FUNCTION wv_save_collection_v1(p JSONB) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE actor BIGINT; collection wv_collections%ROWTYPE; target_id BIGINT; ids JSONB;
BEGIN
 actor:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
 IF actor IS NULL OR wv_writer_rank_v1()<1 THEN RAISE EXCEPTION 'forbidden'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wiki-collections:'||actor,0));
 ids:=p->'documentIds';
 IF jsonb_typeof(ids)<>'array' OR jsonb_array_length(ids)>100 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(ids))<>jsonb_array_length(ids) THEN RAISE EXCEPTION 'invalid_selection'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) v WHERE NOT EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=v::bigint AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL)) THEN RAISE EXCEPTION 'document_missing'; END IF;
 IF p->'inspection'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'content_blocked'; END IF;
 IF NULLIF(p->>'id','') IS NULL THEN
  IF (SELECT count(*) FROM wv_collections WHERE owner_id=actor)>=100 THEN RAISE EXCEPTION 'collection_limit'; END IF;
  INSERT INTO wv_collections(owner_id,title,description,shared) VALUES(actor,p->>'title',COALESCE(p->>'description',''),COALESCE(p->>'shared'='yes',false)) RETURNING id INTO target_id;
 ELSE
  SELECT * INTO collection FROM wv_collections WHERE id=(p->>'id')::bigint AND owner_id=actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF collection.updated_at IS DISTINCT FROM (p->>'version')::timestamptz THEN RAISE EXCEPTION 'version_conflict'; END IF;
  IF p->>'dropUnavailable' IS DISTINCT FROM 'yes' AND EXISTS(SELECT 1 FROM wv_collection_items i WHERE i.collection_id=collection.id AND NOT EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=i.document_id AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL)) THEN RAISE EXCEPTION 'unavailable_collection_items'; END IF;
  UPDATE wv_collections SET title=p->>'title',description=COALESCE(p->>'description',''),shared=COALESCE(p->>'shared'='yes',false),updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=collection.id;
  target_id:=collection.id;
  DELETE FROM wv_collection_items WHERE collection_id=target_id;
 END IF;
 INSERT INTO wv_collection_items(collection_id,document_id,position) SELECT target_id,v::bigint,n::integer FROM jsonb_array_elements_text(ids) WITH ORDINALITY AS input(v,n);
 RETURN target_id;
END $$;
