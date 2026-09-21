-- Short-lived transport only. Parts are removed after assembly and expired
-- sessions are removed on the next transfer request; never used as a file archive.
CREATE TABLE wv_upload_buffers (
 id BIGSERIAL PRIMARY KEY,
 token UUID NOT NULL UNIQUE,
 owner_hash TEXT NOT NULL CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
 file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 240),
 file_size INTEGER NOT NULL CHECK(file_size BETWEEN 1 AND 10485760),
 file_hash TEXT NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),
 part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 10),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+interval '30 minutes',
 CHECK(part_count=ceil(file_size::numeric/1048576))
);
CREATE INDEX wv_upload_buffer_expiry ON wv_upload_buffers(expires_at);
CREATE TABLE wv_upload_parts (
 id BIGSERIAL PRIMARY KEY,
 buffer_id BIGINT NOT NULL REFERENCES wv_upload_buffers(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
 bytes BYTEA NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1048576),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(buffer_id,ordinal)
);
CREATE FUNCTION wv_begin_upload_buffer_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE saved wv_upload_buffers%ROWTYPE;
BEGIN
 IF wv_writer_rank_v1()<2 THEN RAISE EXCEPTION 'forbidden'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wiki-upload-buffer:'||(p->>'owner'),0));
 DELETE FROM wv_upload_buffers WHERE expires_at<NOW();
 SELECT * INTO saved FROM wv_upload_buffers WHERE owner_hash=p->>'owner' AND file_hash=p->>'hash' AND file_size=(p->>'size')::integer AND file_name=p->>'name' FOR UPDATE;
 IF FOUND THEN RETURN to_jsonb(saved); END IF;
 IF (SELECT count(*) FROM wv_upload_buffers WHERE owner_hash=p->>'owner')>=3 THEN RAISE EXCEPTION 'upload_buffer_limit'; END IF;
 INSERT INTO wv_upload_buffers(token,owner_hash,file_name,file_size,file_hash,part_count)
 VALUES((p->>'token')::uuid,p->>'owner',p->>'name',(p->>'size')::integer,p->>'hash',(p->>'parts')::integer) RETURNING * INTO saved;
 RETURN to_jsonb(saved);
END $$;
CREATE FUNCTION wv_put_upload_part_v1(p_token UUID,p_owner TEXT,p_ordinal INTEGER,p_bytes BYTEA) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE buffer wv_upload_buffers%ROWTYPE; existing BYTEA; expected INTEGER;
BEGIN
 IF wv_writer_rank_v1()<2 THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT * INTO buffer FROM wv_upload_buffers WHERE token=p_token AND owner_hash=p_owner AND expires_at>NOW() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'upload_buffer_missing'; END IF;
 IF p_ordinal<0 OR p_ordinal>=buffer.part_count THEN RAISE EXCEPTION 'invalid_part'; END IF;
 expected:=LEAST(1048576,buffer.file_size-p_ordinal*1048576);
 IF octet_length(p_bytes)<>expected THEN RAISE EXCEPTION 'invalid_part'; END IF;
 SELECT bytes INTO existing FROM wv_upload_parts WHERE buffer_id=buffer.id AND ordinal=p_ordinal;
 IF FOUND THEN
  IF existing IS DISTINCT FROM p_bytes THEN RAISE EXCEPTION 'upload_part_conflict'; END IF;
  RETURN;
 END IF;
 INSERT INTO wv_upload_parts(buffer_id,ordinal,bytes) VALUES(buffer.id,p_ordinal,p_bytes);
END $$;
