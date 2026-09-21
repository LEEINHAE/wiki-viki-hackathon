CREATE TABLE IF NOT EXISTS wv_upload_jobs (
  id BIGSERIAL PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  request_key TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received' CHECK(state IN('received','extracting','inspecting','generating','saving','completed','failed','interrupted')),
  attempt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL DEFAULT '파일 수신 완료',
  message TEXT NOT NULL DEFAULT '',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_hash,file_hash,mode),
  UNIQUE(owner_hash,request_key)
);
CREATE INDEX IF NOT EXISTS wv_upload_owner_idx ON wv_upload_jobs(owner_hash,created_at DESC);
CREATE TABLE IF NOT EXISTS wv_upload_sources (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES wv_upload_jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(job_id,ordinal)
);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS wv_upload_job_id BIGINT REFERENCES wv_upload_jobs(id);
CREATE INDEX IF NOT EXISTS wv_drafts_upload_idx ON drafts(wv_upload_job_id,id);
CREATE TABLE IF NOT EXISTS wv_draft_sources (
  draft_id BIGINT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES wv_upload_sources(id),
  PRIMARY KEY(draft_id,source_id)
);
CREATE OR REPLACE FUNCTION wv_finish_upload_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE job wv_upload_jobs%ROWTYPE; item JSONB; v_draft_id BIGINT; items JSONB:='[]'::jsonb; final_result JSONB;
BEGIN
  SELECT * INTO job FROM wv_upload_jobs WHERE id=(p->>'jobId')::bigint FOR UPDATE;
  IF NOT FOUND OR job.attempt<>p->>'attempt' OR job.state<>'saving' THEN RAISE EXCEPTION 'version_conflict'; END IF;
  IF jsonb_array_length(p->'records') NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'invalid_drafts'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p->'records') LOOP
    INSERT INTO drafts(title,slug,content,source_name,aliases,governance,status,editor_handle,field,description,wv_upload_job_id)
      VALUES(item->>'title',item->>'slug',item->>'content',job.file_name,item->'aliases',item->'governance',item->>'status',p->>'editor',item->>'field',item->>'description',job.id) RETURNING id INTO v_draft_id;
    INSERT INTO wv_draft_sources SELECT v_draft_id,id FROM wv_upload_sources WHERE job_id=job.id;
    items:=items||jsonb_build_array(jsonb_build_object('id',v_draft_id,'title',item->>'title','description',item->>'description','status',item->>'status','links',(item->>'links')::integer));
  END LOOP;
  final_result:=jsonb_build_object('type','done','jobId',job.id,'drafts',items,'links',(p->>'links')::integer,'mode',p->>'mode','semanticSkipped',(p->>'semanticSkipped')::boolean);
  UPDATE wv_upload_jobs SET state='completed',stage='초안 저장 완료',result=final_result,message='',updated_at=clock_timestamp() WHERE id=job.id;
  RETURN final_result;
END $$;

CREATE OR REPLACE FUNCTION wv_store_upload_sources_v1(p_id BIGINT,p_attempt TEXT,p_segments JSONB) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM wv_upload_jobs WHERE id=p_id AND attempt=p_attempt AND state='inspecting' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'version_conflict'; END IF;
  DELETE FROM wv_upload_sources WHERE job_id=p_id;
  INSERT INTO wv_upload_sources(job_id,ordinal,kind,position,label,text)
    SELECT p_id,s.ordinal,s.kind,s.position,s.label,s.text FROM jsonb_to_recordset(p_segments) AS s(ordinal integer,kind text,position integer,label text,text text);
END $$;
