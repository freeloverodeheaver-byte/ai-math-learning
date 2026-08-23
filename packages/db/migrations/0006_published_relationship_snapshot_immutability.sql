CREATE FUNCTION reject_locked_question_version_relationship_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND EXISTS (
    SELECT 1 FROM question_versions
    WHERE id = OLD.question_version_id AND review_state IN ('published', 'retired')
  ) THEN
    RAISE EXCEPTION 'question version relationship snapshot is locked';
  END IF;

  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM question_versions
    WHERE id = NEW.question_version_id AND review_state IN ('published', 'retired')
  ) THEN
    RAISE EXCEPTION 'question version relationship snapshot is locked';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER question_version_knowledge_points_locked_immutable
BEFORE INSERT OR UPDATE OR DELETE ON question_version_knowledge_points
FOR EACH ROW EXECUTE FUNCTION reject_locked_question_version_relationship_mutation();

CREATE FUNCTION reject_locked_knowledge_version_prerequisite_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND EXISTS (
    SELECT 1 FROM knowledge_point_versions
    WHERE id = OLD.knowledge_point_version_id AND review_state IN ('published', 'retired')
  ) THEN
    RAISE EXCEPTION 'knowledge version prerequisite snapshot is locked';
  END IF;

  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM knowledge_point_versions
    WHERE id = NEW.knowledge_point_version_id AND review_state IN ('published', 'retired')
  ) THEN
    RAISE EXCEPTION 'knowledge version prerequisite snapshot is locked';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_point_version_prerequisites_locked_immutable
BEFORE INSERT OR UPDATE OR DELETE ON knowledge_point_version_prerequisites
FOR EACH ROW EXECUTE FUNCTION reject_locked_knowledge_version_prerequisite_mutation();

CREATE FUNCTION reject_locked_content_version_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.review_state = 'retired' AND NEW.review_state IS DISTINCT FROM OLD.review_state THEN
    RAISE EXCEPTION 'retired content versions are terminal';
  END IF;

  IF OLD.review_state = 'published' AND NEW.review_state NOT IN ('published', 'retired') THEN
    RAISE EXCEPTION 'published content versions cannot return to an editable state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER question_versions_locked_lifecycle
BEFORE UPDATE OF review_state ON question_versions
FOR EACH ROW EXECUTE FUNCTION reject_locked_content_version_lifecycle();

CREATE TRIGGER knowledge_point_versions_locked_lifecycle
BEFORE UPDATE OF review_state ON knowledge_point_versions
FOR EACH ROW EXECUTE FUNCTION reject_locked_content_version_lifecycle();
