ALTER TABLE documents ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
ALTER TABLE documents ADD COLUMN wv_archived_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'editor' CHECK(wv_min_role IN('editor','reviewer','admin'));
CREATE FUNCTION wv_role_rank_v1(value TEXT) RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$
 SELECT CASE value WHEN 'reader' THEN 1 WHEN 'editor' THEN 2 WHEN 'reviewer' THEN 3 WHEN 'admin' THEN 4 ELSE 0 END
$$;
CREATE FUNCTION wv_actor_rank_v1() RETURNS INTEGER LANGUAGE SQL STABLE AS $$
 SELECT CASE WHEN current_setting('wv.operator',true)='1' OR current_setting('wv.actor_role',true)='demo' THEN 4
 ELSE COALESCE((SELECT wv_role_rank_v1(role) FROM wv_users WHERE id=NULLIF(current_setting('wv.actor_id',true),'')::bigint AND active),0) END
$$;
CREATE FUNCTION wv_writer_rank_v1() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE actor_role TEXT;
BEGIN
 IF current_setting('wv.operator',true)='1' OR current_setting('wv.actor_role',true)='demo' THEN RETURN 4; END IF;
 SELECT role INTO actor_role FROM wv_users WHERE id=NULLIF(current_setting('wv.actor_id',true),'')::bigint AND active FOR SHARE;
 RETURN wv_role_rank_v1(actor_role);
END $$;
CREATE VIEW wv_visible_documents AS SELECT * FROM documents
 WHERE wv_role_rank_v1(wv_min_role)<=(SELECT wv_actor_rank_v1())
 AND (deleted_at IS NULL OR (SELECT wv_actor_rank_v1())>=4)
 AND (wv_archived_at IS NULL OR (SELECT wv_actor_rank_v1())>=3);
CREATE VIEW wv_visible_drafts AS SELECT * FROM drafts
 WHERE wv_role_rank_v1(wv_min_role)<=(SELECT wv_actor_rank_v1())
 AND ((SELECT wv_actor_rank_v1())>=4 OR governance->'merge'->>'targetId' IS NULL OR EXISTS(SELECT 1 FROM wv_visible_documents d WHERE d.id=(governance->'merge'->>'targetId')::bigint AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL));

-- Recheck the current account inside writes, including a session revoked while
-- an external AI request was in flight. CLI migration/seed tools explicitly set
-- wv.operator only in their own trusted transactions.
CREATE FUNCTION wv_guard_document_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE rank INTEGER;
BEGIN
  IF current_setting('wv.operator',true)='1' THEN RETURN NEW; END IF;
  rank:=wv_writer_rank_v1();
  IF rank<2 OR rank<wv_role_rank_v1(NEW.wv_min_role) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF TG_OP='UPDATE' THEN
    IF rank<wv_role_rank_v1(OLD.wv_min_role) OR (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND rank<4)
      OR (wv_role_rank_v1(NEW.wv_min_role)<wv_role_rank_v1(OLD.wv_min_role) AND rank<4)
      OR (NEW.wv_archived_at IS DISTINCT FROM OLD.wv_archived_at AND rank<3)
      THEN RAISE EXCEPTION 'forbidden'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wv_document_write_guard BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION wv_guard_document_v1();
CREATE FUNCTION wv_guard_draft_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE rank INTEGER;
BEGIN
  IF current_setting('wv.operator',true)='1' THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  rank:=wv_writer_rank_v1();
  IF rank<2 OR (TG_OP<>'INSERT' AND rank<wv_role_rank_v1(OLD.wv_min_role)) OR (TG_OP<>'DELETE' AND rank<wv_role_rank_v1(NEW.wv_min_role)) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF TG_OP='UPDATE' AND NEW.governance->'review' IS DISTINCT FROM OLD.governance->'review' AND NEW.governance->'review' IS NOT NULL AND rank<3 THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'published' AND NEW.status='published' AND rank<3 THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wv_draft_write_guard BEFORE INSERT OR UPDATE OR DELETE ON drafts FOR EACH ROW EXECUTE FUNCTION wv_guard_draft_v1();

CREATE OR REPLACE VIEW wv_link_edges AS
SELECT DISTINCT a.id AS source_id,a.slug AS source_slug,a.title AS source_title,b.id AS target_id,b.slug AS target_slug,b.title AS target_title
FROM wv_document_links l JOIN wv_visible_documents a ON a.id=l.document_id AND a.deleted_at IS NULL AND a.wv_archived_at IS NULL
LEFT JOIN redirects r ON r.alias_slug=l.target_slug
JOIN wv_visible_documents b ON b.id=COALESCE((SELECT id FROM wv_visible_documents WHERE slug=l.target_slug),r.document_id) AND b.deleted_at IS NULL AND b.wv_archived_at IS NULL
WHERE a.id<>b.id;

-- Draft publication must never lower the source's audience restriction.
CREATE FUNCTION wv_keep_publication_access_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id BIGINT;
BEGIN
  target_id:=COALESCE((NEW.governance->>'publishedDocumentId')::bigint,(NEW.governance->'mergedInto'->>'id')::bigint);
  IF target_id IS NOT NULL THEN
    UPDATE documents SET wv_min_role=NEW.wv_min_role WHERE id=target_id AND wv_role_rank_v1(wv_min_role)<wv_role_rank_v1(NEW.wv_min_role) AND NEW.wv_min_role<>'editor';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wv_publish_access AFTER UPDATE OF status ON drafts FOR EACH ROW WHEN(NEW.status='published' AND OLD.status<>'published') EXECUTE FUNCTION wv_keep_publication_access_v1();

CREATE OR REPLACE FUNCTION wv_search_documents_v1(p JSONB) RETURNS JSONB LANGUAGE SQL STABLE AS $$
WITH terms AS (SELECT value AS term FROM jsonb_array_elements_text(COALESCE(p->'terms','[]'::jsonb))),
base AS (
  SELECT d.id,d.slug,d.title,d.field,d.editor_handle,d.updated_at,d.source_name,
    COALESCE(d.governance->>'reviewState','needs_review') AS state,
    COALESCE((SELECT jsonb_agg(tag ORDER BY tag) FROM wv_document_tags t WHERE t.document_id=d.id),'[]'::jsonb) AS tags,
    CASE WHEN wv_normalize_v1(d.title)=p->>'normalized' THEN 1000
      WHEN EXISTS(SELECT 1 FROM redirects r WHERE r.document_id=d.id AND wv_normalize_v1(r.alias_title)=p->>'normalized') THEN 900 ELSE 0 END
      + COALESCE((SELECT sum(CASE WHEN position(term IN wv_normalize_v1(d.title))>0 THEN 30
      WHEN EXISTS(SELECT 1 FROM redirects r WHERE r.document_id=d.id AND position(term IN wv_normalize_v1(r.alias_title))>0) THEN 20 ELSE 1 END) FROM terms),0) AS score,
    CASE WHEN COALESCE(p->>'q','')='' THEN COALESCE(NULLIF(d.description,''),left(d.content,240))
      ELSE substring(d.content FROM greatest(1,COALESCE((SELECT min(NULLIF(position(lower(term) IN lower(d.content)),0)) FROM terms),1)-80) FOR 320) END AS snippet
  FROM wv_visible_documents d WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM terms WHERE position(term IN d.wv_search_text)=0
      AND NOT EXISTS(SELECT 1 FROM redirects r WHERE r.document_id=d.id AND position(term IN wv_normalize_v1(r.alias_title))>0))
    AND (COALESCE(p->>'state','')='' OR COALESCE(d.governance->>'reviewState','needs_review')=p->>'state')
    AND (COALESCE(p->>'tag','')='' OR EXISTS(SELECT 1 FROM wv_document_tags t WHERE t.document_id=d.id AND t.tag=p->>'tag'))
    AND (COALESCE(p->>'days','')='' OR d.updated_at>=NOW()-make_interval(days=>(p->>'days')::integer))
), filtered AS (SELECT * FROM base WHERE COALESCE(p->>'field','')='' OR field=p->>'field'),
page AS (SELECT * FROM filtered ORDER BY CASE WHEN p->>'sort'='recent' THEN 0 ELSE score END DESC,updated_at DESC,id DESC
 LIMIT LEAST(40,GREATEST(1,COALESCE((p->>'limit')::integer,20))) OFFSET GREATEST(0,COALESCE((p->>'page')::integer,1)-1)*LEAST(40,GREATEST(1,COALESCE((p->>'limit')::integer,20)))),
summary AS (SELECT page.*,
  (SELECT count(*) FROM wv_link_edges e WHERE e.target_id=page.id) AS backlink_count,
  (SELECT id FROM revisions r WHERE r.document_id=page.id ORDER BY created_at DESC,id DESC LIMIT 1) AS revision_id FROM page)
SELECT jsonb_build_object('results',COALESCE((SELECT jsonb_agg(to_jsonb(summary)) FROM summary),'[]'::jsonb),
  'total',(SELECT count(*) FROM filtered),
  'facets',COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM (SELECT field AS name,count(*) AS count FROM base GROUP BY field ORDER BY field) f),'[]'::jsonb))
$$;
