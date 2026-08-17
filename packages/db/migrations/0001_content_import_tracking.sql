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

CREATE TABLE content_bundle_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id text NOT NULL REFERENCES content_bundles(bundle_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  payload_hash text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX content_bundle_versions_bundle_version_unique
ON content_bundle_versions (bundle_id, version);
