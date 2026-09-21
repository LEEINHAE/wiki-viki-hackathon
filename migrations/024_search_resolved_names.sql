-- Resolve visible historical names once per search, rather than recursively
-- rebuilding the name graph for every document and every query term.
CREATE OR REPLACE FUNCTION wv_search_documents_v1(p JSONB) RETURNS JSONB LANGUAGE SQL STABLE AS $$
WITH terms AS (SELECT value AS term FROM jsonb_array_elements_text(COALESCE(p->'terms','[]'::jsonb))),
names AS MATERIALIZED (
 SELECT document_id,array_agg(DISTINCT wv_normalize_v1(alias_title)) AS titles
 FROM wv_resolved_names GROUP BY document_id
),
base AS (
 SELECT d.id,d.slug,d.title,d.field,d.editor_handle,d.updated_at,d.source_name,
 COALESCE(d.governance->>'reviewState','needs_review') AS state,
 COALESCE((SELECT jsonb_agg(tag ORDER BY tag) FROM wv_document_tags t WHERE t.document_id=d.id),'[]'::jsonb) AS tags,
 CASE WHEN wv_normalize_v1(d.title)=p->>'normalized' THEN 1000
 WHEN (p->>'normalized')=ANY(n.titles) THEN 900 ELSE 0 END
 + COALESCE((SELECT sum(CASE WHEN position(term IN wv_normalize_v1(d.title))>0 THEN 30
 WHEN EXISTS(SELECT 1 FROM unnest(n.titles) name WHERE position(term IN name)>0) THEN 20 ELSE 1 END) FROM terms),0) AS score,
 CASE WHEN COALESCE(p->>'q','')='' THEN COALESCE(NULLIF(d.description,''),left(d.content,240))
 ELSE substring(d.content FROM greatest(1,COALESCE((SELECT min(NULLIF(position(lower(term) IN lower(d.content)),0)) FROM terms),1)-80) FOR 320) END AS snippet
 FROM wv_current_documents d LEFT JOIN names n ON n.document_id=d.id
 WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM terms WHERE position(term IN d.wv_search_text)=0
 AND NOT EXISTS(SELECT 1 FROM unnest(n.titles) name WHERE position(term IN name)>0))
 AND (COALESCE(p->>'state','')='' OR COALESCE(d.governance->>'reviewState','needs_review')=p->>'state')
 AND (COALESCE(p->>'tag','')='' OR EXISTS(SELECT 1 FROM wv_document_tags t WHERE t.document_id=d.id AND t.tag=p->>'tag'))
 AND (COALESCE(p->>'days','')='' OR d.updated_at>=NOW()-make_interval(days=>(p->>'days')::integer))
), filtered AS (SELECT * FROM base WHERE COALESCE(p->>'field','')='' OR field=p->>'field'),
page AS (SELECT * FROM filtered ORDER BY CASE WHEN p->>'sort'='recent' THEN 0 ELSE score END DESC,updated_at DESC,id DESC
 LIMIT LEAST(40,GREATEST(1,COALESCE((p->>'limit')::integer,20))) OFFSET GREATEST(0,COALESCE((p->>'page')::integer,1)-1)*LEAST(40,GREATEST(1,COALESCE((p->>'limit')::integer,20)))),
summary AS (SELECT page.*,
 CASE WHEN p->>'compact'='true' THEN NULL ELSE (SELECT count(*) FROM wv_link_edges e WHERE e.target_id=page.id) END AS backlink_count,
 CASE WHEN p->>'compact'='true' THEN NULL ELSE (SELECT id FROM wv_visible_revisions r WHERE r.document_id=page.id ORDER BY created_at DESC,id DESC LIMIT 1) END AS revision_id FROM page)
SELECT jsonb_build_object('results',COALESCE((SELECT jsonb_agg(to_jsonb(summary)) FROM summary),'[]'::jsonb),
 'total',CASE WHEN p->>'compact'='true' THEN NULL ELSE (SELECT count(*) FROM filtered) END,
 'facets',CASE WHEN p->>'compact'='true' THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM (SELECT field AS name,count(*) AS count FROM base GROUP BY field ORDER BY field) f),'[]'::jsonb) END)
$$;
