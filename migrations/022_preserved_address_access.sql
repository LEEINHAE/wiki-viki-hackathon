ALTER TABLE wv_preserved_routes ADD COLUMN wv_min_role TEXT NOT NULL DEFAULT 'reader' CHECK(wv_min_role IN('reader','editor','reviewer','admin'));
CREATE FUNCTION wv_address_min_role_v1(p_id BIGINT,p_slug TEXT,p_title TEXT) RETURNS TEXT LANGUAGE SQL STABLE AS $$
 SELECT COALESCE((SELECT COALESCE(r.document_state->>'minRole','reader') FROM revisions r
  WHERE r.document_id=p_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.document_state->'aliases','[]')) a WHERE a->>'slug'=p_slug AND a->>'title'=p_title)
  ORDER BY wv_role_rank_v1(COALESCE(r.document_state->>'minRole','reader')) LIMIT 1),
  (SELECT wv_min_role FROM documents WHERE id=p_id))
$$;
UPDATE wv_preserved_routes SET wv_min_role=wv_address_min_role_v1(document_id,slug,title);
CREATE FUNCTION wv_preserved_route_access_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.wv_min_role:=wv_address_min_role_v1(NEW.document_id,NEW.slug,NEW.title); RETURN NEW; END $$;
CREATE TRIGGER wv_preserved_route_access BEFORE INSERT ON wv_preserved_routes FOR EACH ROW EXECUTE FUNCTION wv_preserved_route_access_v1();
CREATE OR REPLACE VIEW wv_resolved_names AS
 SELECT d.slug AS alias_slug,d.title AS alias_title,p.target_id AS document_id FROM wv_document_roots p JOIN wv_visible_documents d ON d.id=p.source_id
 UNION SELECT r.alias_slug,r.alias_title,p.target_id FROM redirects r JOIN wv_document_roots p ON p.source_id=r.document_id
 UNION SELECT r.slug,r.title,p.target_id FROM wv_preserved_routes r JOIN wv_document_roots p ON p.source_id=r.document_id WHERE wv_role_rank_v1(r.wv_min_role)<=(SELECT wv_actor_rank_v1());
