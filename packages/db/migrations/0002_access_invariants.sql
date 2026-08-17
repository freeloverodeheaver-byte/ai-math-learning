DROP INDEX class_memberships_active_unique;

WITH ranked_open_memberships AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY class_id, student_profile_id
      ORDER BY
        CASE WHEN state = 'active' THEN 0 ELSE 1 END,
        requested_at,
        id
    ) AS survivor_rank
  FROM class_memberships
  WHERE state IN ('requested', 'active')
), rejected_duplicates AS (
  UPDATE class_memberships AS membership
  SET
    state = 'rejected',
    resolved_at = now()
  FROM ranked_open_memberships AS ranked
  WHERE membership.id = ranked.id
    AND ranked.survivor_rank > 1
  RETURNING membership.id, membership.class_id, membership.student_profile_id
)
INSERT INTO audit_events (
  actor_user_id,
  action,
  subject_type,
  subject_id,
  metadata
)
SELECT
  NULL,
  'class_membership.migration_rejected_duplicate',
  'class_membership',
  duplicate.id::text,
  jsonb_build_object(
    'membershipId', duplicate.id,
    'studentProfileId', duplicate.student_profile_id,
    'classId', duplicate.class_id,
    'oldState', 'requested',
    'newState', 'rejected'
  )
FROM rejected_duplicates AS duplicate;

UPDATE class_memberships
SET resolved_at = requested_at
WHERE state <> 'requested'
  AND resolved_at IS NULL;

ALTER TABLE class_memberships
ADD CONSTRAINT class_memberships_state_resolved_check CHECK (
  (state = 'requested' AND resolved_at IS NULL)
  OR (state IN ('active', 'rejected', 'revoked') AND resolved_at IS NOT NULL)
);

CREATE UNIQUE INDEX class_memberships_open_unique
ON class_memberships (class_id, student_profile_id)
WHERE state IN ('requested', 'active');

ALTER TABLE data_sharing_grants
ADD CONSTRAINT data_sharing_grants_scope_check CHECK (
  scope IN ('learning_summary', 'shared_personal_content')
);

CREATE FUNCTION enforce_active_data_sharing_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1
    FROM class_memberships AS membership
    WHERE membership.id = NEW.class_membership_id
      AND membership.state = 'active'
      AND membership.student_profile_id = NEW.student_profile_id
  ) THEN
    RAISE EXCEPTION 'an active data sharing grant requires an active membership for the same student';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER data_sharing_grants_active_integrity
AFTER INSERT OR UPDATE OF class_membership_id, student_profile_id, revoked_at
ON data_sharing_grants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_active_data_sharing_grant();

CREATE FUNCTION enforce_membership_active_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM data_sharing_grants AS sharing_grant
    WHERE sharing_grant.class_membership_id = NEW.id
      AND sharing_grant.revoked_at IS NULL
      AND (
        NEW.state <> 'active'
        OR sharing_grant.student_profile_id <> NEW.student_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'a membership with an active grant must remain active for the same student';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER class_memberships_active_grants_integrity
AFTER UPDATE OF state, student_profile_id
ON class_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_membership_active_grants();
