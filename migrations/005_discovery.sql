-- Materialize only link targets. Resolve aliases at read time so renames and trash
-- immediately affect search, backlinks and the map without rewriting old bodies.
CREATE TABLE IF NOT EXISTS wv_document_links (
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_slug TEXT NOT NULL,
  target_title TEXT NOT NULL,
  PRIMARY KEY(document_id,target_slug)
);
CREATE INDEX IF NOT EXISTS wv_links_target_idx ON wv_document_links(target_slug,document_id);
CREATE TABLE IF NOT EXISTS wv_document_tags (
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK(length(tag) BETWEEN 1 AND 40),
  PRIMARY KEY(document_id,tag)
);
CREATE INDEX IF NOT EXISTS wv_tags_name_idx ON wv_document_tags(tag,document_id);
CREATE OR REPLACE FUNCTION wv_slug_v1(value TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT lower(regexp_replace(regexp_replace(regexp_replace(trim(value),'[[:space:]_]+','-','g'),'[^[:alnum:]:.~\-]','','g'),'-+','-','g'))
$$;
CREATE OR REPLACE FUNCTION wv_normalize_v1(value TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT regexp_replace(lower(COALESCE(value,'')),'[[:space:]_\-]+','','g')
$$;
CREATE INDEX IF NOT EXISTS wv_title_normal_idx ON documents(wv_normalize_v1(title)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS wv_alias_normal_idx ON redirects(wv_normalize_v1(alias_title));
CREATE OR REPLACE FUNCTION wv_link_targets_v1(body TEXT) RETURNS TABLE(slug TEXT,title TEXT) LANGUAGE SQL IMMUTABLE AS $$
  WITH clean AS (SELECT regexp_replace(regexp_replace(body,'```.*?```|~~~.*?~~~','','g'),'`[^`]*`','','g') AS text),
  names AS (SELECT trim(m[1]) AS title FROM clean,regexp_matches(text,'\[\[([^]|]+)(\|[^]]*)?\]\]','g') AS m)
  SELECT DISTINCT ON(wv_slug_v1(title)) wv_slug_v1(title),title FROM names
  WHERE title !~* '^(https?://|파일:|분류:)' AND wv_slug_v1(title)<>'' ORDER BY wv_slug_v1(title),title
$$;
CREATE OR REPLACE FUNCTION wv_sync_links_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM wv_document_links WHERE document_id=NEW.id;
  INSERT INTO wv_document_links SELECT NEW.id,slug,title FROM wv_link_targets_v1(NEW.content);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wv_document_links_sync ON documents;
CREATE TRIGGER wv_document_links_sync AFTER INSERT OR UPDATE OF content ON documents FOR EACH ROW EXECUTE FUNCTION wv_sync_links_v1();
INSERT INTO wv_document_links SELECT d.id,t.slug,t.title FROM documents d CROSS JOIN LATERAL wv_link_targets_v1(d.content) t
ON CONFLICT(document_id,target_slug) DO UPDATE SET target_title=EXCLUDED.target_title;
CREATE OR REPLACE VIEW wv_link_edges AS
SELECT DISTINCT a.id AS source_id,a.slug AS source_slug,a.title AS source_title,b.id AS target_id,b.slug AS target_slug,b.title AS target_title
FROM wv_document_links l JOIN documents a ON a.id=l.document_id AND a.deleted_at IS NULL
LEFT JOIN redirects r ON r.alias_slug=l.target_slug
JOIN documents b ON b.id=COALESCE((SELECT id FROM documents WHERE slug=l.target_slug),r.document_id) AND b.deleted_at IS NULL
WHERE a.id<>b.id;

-- Return only a bounded page of excerpts; bodies stay in PostgreSQL.
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
  FROM documents d WHERE d.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM terms WHERE position(term IN wv_normalize_v1(d.title||' '||d.content))=0
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
