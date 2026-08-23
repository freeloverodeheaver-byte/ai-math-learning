CREATE TABLE knowledge_point_version_prerequisites (
  knowledge_point_version_id uuid NOT NULL REFERENCES knowledge_point_versions(id) ON DELETE CASCADE,
  prerequisite_knowledge_point_id uuid NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_point_version_prerequisites_pk PRIMARY KEY (knowledge_point_version_id, prerequisite_knowledge_point_id)
);

CREATE TABLE question_version_knowledge_points (
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  knowledge_point_id uuid NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  CONSTRAINT question_version_knowledge_points_pk PRIMARY KEY (question_version_id, knowledge_point_id)
);

-- The legacy schema retained only the effective stable-entity relationship. Copy that
-- best recoverable snapshot to every historical version before new immutable snapshots begin.
INSERT INTO knowledge_point_version_prerequisites (knowledge_point_version_id, prerequisite_knowledge_point_id)
SELECT v.id, p.prerequisite_knowledge_point_id
FROM knowledge_point_versions v
JOIN knowledge_prerequisites p ON p.knowledge_point_id = v.knowledge_point_id;

INSERT INTO question_version_knowledge_points (question_version_id, knowledge_point_id)
SELECT v.id, l.knowledge_point_id
FROM question_versions v
JOIN question_knowledge_points l ON l.question_id = v.question_id;

DROP TRIGGER question_versions_published_integrity ON question_versions;
CREATE OR REPLACE FUNCTION enforce_published_question_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_state = 'published' THEN
    IF NEW.source_id IS NULL THEN
      RAISE EXCEPTION 'published question versions require a source';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM question_version_knowledge_points WHERE question_version_id = NEW.id) THEN
      RAISE EXCEPTION 'published question versions require a knowledge-point link';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER question_versions_published_integrity
AFTER INSERT OR UPDATE OF source_id, review_state ON question_versions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_published_question_version();

CREATE FUNCTION enforce_published_question_version_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM question_versions WHERE id = OLD.question_version_id AND review_state = 'published')
     AND NOT EXISTS (SELECT 1 FROM question_version_knowledge_points WHERE question_version_id = OLD.question_version_id) THEN
    RAISE EXCEPTION 'published question versions require a knowledge-point link';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER question_version_knowledge_points_published_integrity
AFTER DELETE OR UPDATE OF question_version_id ON question_version_knowledge_points
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_published_question_version_link();

CREATE FUNCTION reject_content_owner_bundle_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bundle_id IS DISTINCT FROM OLD.bundle_id THEN
    RAISE EXCEPTION 'content owner bundle_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_entity_owners_bundle_immutable
BEFORE UPDATE OF bundle_id ON content_entity_owners
FOR EACH ROW EXECUTE FUNCTION reject_content_owner_bundle_reassignment();
