CREATE OR REPLACE FUNCTION reject_locked_question_version_relationship_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  locked_version record;
BEGIN
  FOR locked_version IN
    SELECT id, review_state
    FROM question_versions
    WHERE id = ANY(ARRAY[
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.question_version_id END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.question_version_id END
    ])
    ORDER BY id
    FOR UPDATE
  LOOP
    IF locked_version.review_state IN ('published', 'retired') THEN
      RAISE EXCEPTION 'question version relationship snapshot is locked';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_locked_knowledge_version_prerequisite_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  locked_version record;
BEGIN
  FOR locked_version IN
    SELECT id, review_state
    FROM knowledge_point_versions
    WHERE id = ANY(ARRAY[
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.knowledge_point_version_id END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.knowledge_point_version_id END
    ])
    ORDER BY id
    FOR UPDATE
  LOOP
    IF locked_version.review_state IN ('published', 'retired') THEN
      RAISE EXCEPTION 'knowledge version prerequisite snapshot is locked';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_locked_content_version_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.review_state IN ('published', 'retired') THEN
    RAISE EXCEPTION 'locked content versions cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER question_versions_locked_delete
BEFORE DELETE ON question_versions
FOR EACH ROW EXECUTE FUNCTION reject_locked_content_version_deletion();

CREATE TRIGGER knowledge_point_versions_locked_delete
BEFORE DELETE ON knowledge_point_versions
FOR EACH ROW EXECUTE FUNCTION reject_locked_content_version_deletion();
