CREATE UNIQUE INDEX sources_label_unique ON sources (label);

CREATE TABLE content_bundle_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  payload_hash text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX content_bundle_versions_bundle_version_unique
ON content_bundle_versions (bundle_id, version);
