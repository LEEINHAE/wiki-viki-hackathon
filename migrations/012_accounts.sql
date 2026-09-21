CREATE TABLE wv_users (
  id BIGSERIAL PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('reader','editor','reviewer','admin')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE wv_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES wv_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX wv_sessions_expiry ON wv_sessions(expires_at);
CREATE TABLE wv_login_limits (
  id BIGSERIAL PRIMARY KEY,
  identity_hash TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL,
  UNIQUE(identity_hash,window_start)
);
CREATE TABLE wv_account_events (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES wv_users(id),
  subject_id BIGINT NOT NULL REFERENCES wv_users(id),
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE revisions ADD COLUMN actor_id BIGINT REFERENCES wv_users(id);
ALTER TABLE discussions ADD COLUMN actor_id BIGINT REFERENCES wv_users(id);
ALTER TABLE drafts ADD COLUMN actor_id BIGINT REFERENCES wv_users(id);
CREATE FUNCTION wv_record_actor_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.actor_id:=NULLIF(current_setting('wv.actor_id',true),'')::bigint;
  RETURN NEW;
END $$;
CREATE TRIGGER wv_revision_actor BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION wv_record_actor_v1();
CREATE TRIGGER wv_discussion_actor BEFORE INSERT ON discussions FOR EACH ROW EXECUTE FUNCTION wv_record_actor_v1();
CREATE TRIGGER wv_draft_actor BEFORE INSERT ON drafts FOR EACH ROW EXECUTE FUNCTION wv_record_actor_v1();

CREATE FUNCTION wv_change_user_v1(p_actor BIGINT,p_subject BIGINT,p_role TEXT,p_active BOOLEAN) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE previous wv_users%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(21470921,3);
  IF NOT EXISTS(SELECT 1 FROM wv_users WHERE id=p_actor AND active AND role='admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO previous FROM wv_users WHERE id=p_subject FOR UPDATE;
  IF NOT FOUND OR p_role NOT IN('reader','editor','reviewer','admin') THEN RAISE EXCEPTION 'invalid_account'; END IF;
  IF previous.role='admin' AND previous.active AND (NOT p_active OR p_role<>'admin')
    AND (SELECT count(*) FROM wv_users WHERE active AND role='admin')<=1 THEN RAISE EXCEPTION 'last_admin'; END IF;
  UPDATE wv_users SET role=p_role,active=p_active,updated_at=clock_timestamp() WHERE id=p_subject;
  DELETE FROM wv_sessions WHERE user_id=p_subject;
  INSERT INTO wv_account_events(actor_id,subject_id,action,details) VALUES(p_actor,p_subject,'access_changed',jsonb_build_object('role',p_role,'active',p_active));
END $$;

CREATE FUNCTION wv_change_password_v1(p_id BIGINT,p_previous TEXT,p_next TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 UPDATE wv_users SET password_hash=p_next,updated_at=clock_timestamp() WHERE id=p_id AND active AND password_hash=p_previous;
 IF NOT FOUND THEN RAISE EXCEPTION 'version_conflict'; END IF;
 DELETE FROM wv_sessions WHERE user_id=p_id;
 INSERT INTO wv_account_events(actor_id,subject_id,action) VALUES(p_id,p_id,'password_changed');
END $$;
