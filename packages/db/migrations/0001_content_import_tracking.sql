WITH ranked_sources AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY label ORDER BY created_at, id) AS survivor_id
  FROM sources
)
UPDATE question_versions AS version
SET source_id = ranked.survivor_id
FROM ranked_sources AS ranked
WHERE version.source_id = ranked.id
  AND ranked.id <> ranked.survivor_id;

WITH ranked_sources AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY label ORDER BY created_at, id) AS survivor_id
  FROM sources
)
UPDATE knowledge_point_versions AS version
SET source_id = ranked.survivor_id
FROM ranked_sources AS ranked
WHERE version.source_id = ranked.id
  AND ranked.id <> ranked.survivor_id;

DELETE FROM sources AS duplicate
WHERE EXISTS (
  SELECT 1
  FROM sources AS survivor
  WHERE survivor.label = duplicate.label
    AND (survivor.created_at, survivor.id) < (duplicate.created_at, duplicate.id)
);

CREATE UNIQUE INDEX sources_label_unique ON sources (label);

CREATE TABLE content_bundles (
  bundle_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_entity_owners (
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  bundle_id text NOT NULL REFERENCES content_bundles(bundle_id) ON DELETE RESTRICT,
  CONSTRAINT content_entity_owners_pk PRIMARY KEY (entity_type, entity_key),
  CONSTRAINT content_entity_owners_type_check CHECK (entity_type IN ('knowledge', 'question'))
);

INSERT INTO content_bundles (bundle_id)
SELECT '__legacy_pre_import__'
WHERE EXISTS (SELECT 1 FROM knowledge_points)
   OR EXISTS (SELECT 1 FROM questions);

INSERT INTO content_entity_owners (entity_type, entity_key, bundle_id)
SELECT 'knowledge', canonical_id, '__legacy_pre_import__'
FROM knowledge_points;

INSERT INTO content_entity_owners (entity_type, entity_key, bundle_id)
SELECT 'question', external_key, '__legacy_pre_import__'
FROM questions;

CREATE FUNCTION enforce_knowledge_point_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_entity_owners
    WHERE entity_type = 'knowledge' AND entity_key = NEW.canonical_id
  ) THEN
    RAISE EXCEPTION 'knowledge point % requires a matching content owner', NEW.canonical_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER knowledge_points_owner_integrity
AFTER INSERT OR UPDATE OF canonical_id ON knowledge_points
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_point_owner();

CREATE FUNCTION enforce_question_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_entity_owners
    WHERE entity_type = 'question' AND entity_key = NEW.external_key
  ) THEN
    RAISE EXCEPTION 'question % requires a matching content owner', NEW.external_key;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER questions_owner_integrity
AFTER INSERT OR UPDATE OF external_key ON questions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_question_owner();

CREATE TABLE content_bundle_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id text NOT NULL REFERENCES content_bundles(bundle_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  payload_hash text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX content_bundle_versions_bundle_version_unique
ON content_bundle_versions (bundle_id, version);
