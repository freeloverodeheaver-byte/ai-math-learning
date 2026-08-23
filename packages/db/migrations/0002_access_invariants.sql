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

WITH invalid_grants AS (
  SELECT
    sharing_grant.id,
    sharing_grant.class_membership_id,
    sharing_grant.student_profile_id,
    sharing_grant.scope,
    ARRAY_REMOVE(ARRAY[
      CASE
        WHEN sharing_grant.scope NOT IN ('learning_summary', 'shared_personal_content')
        THEN 'unknown_scope'
      END,
      CASE
        WHEN membership.id IS NULL OR membership.state <> 'active'
        THEN 'membership_not_active'
      END,
      CASE
        WHEN membership.id IS NOT NULL
          AND membership.student_profile_id <> sharing_grant.student_profile_id
        THEN 'student_mismatch'
      END
    ], NULL) AS reasons
  FROM data_sharing_grants AS sharing_grant
  LEFT JOIN class_memberships AS membership
    ON membership.id = sharing_grant.class_membership_id
  WHERE sharing_grant.revoked_at IS NULL
    AND (
      sharing_grant.scope NOT IN ('learning_summary', 'shared_personal_content')
      OR membership.id IS NULL
      OR membership.state <> 'active'
      OR membership.student_profile_id <> sharing_grant.student_profile_id
    )
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
  'data_sharing_grant.migration_revoked_invalid',
  'data_sharing_grant',
  invalid_grant.id::text,
  jsonb_build_object(
    'grantId', invalid_grant.id,
    'classMembershipId', invalid_grant.class_membership_id,
    'studentProfileId', invalid_grant.student_profile_id,
    'scope', invalid_grant.scope,
    'reasons', invalid_grant.reasons
  )
FROM invalid_grants AS invalid_grant;

UPDATE data_sharing_grants AS sharing_grant
SET revoked_at = sharing_grant.granted_at
FROM class_memberships AS membership
WHERE sharing_grant.class_membership_id = membership.id
  AND sharing_grant.revoked_at IS NULL
  AND (
    sharing_grant.scope NOT IN ('learning_summary', 'shared_personal_content')
    OR membership.state <> 'active'
    OR membership.student_profile_id <> sharing_grant.student_profile_id
  );

ALTER TABLE data_sharing_grants
ADD CONSTRAINT data_sharing_grants_scope_check CHECK (
  revoked_at IS NOT NULL
  OR scope IN ('learning_summary', 'shared_personal_content')
);

CREATE FUNCTION enforce_active_data_sharing_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'data sharing grant revocation is irreversible';
    END IF;

    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND (
      NEW.class_membership_id IS DISTINCT FROM OLD.class_membership_id
      OR NEW.student_profile_id IS DISTINCT FROM OLD.student_profile_id
      OR NEW.scope IS DISTINCT FROM OLD.scope
    ) THEN
      RAISE EXCEPTION 'an unrevoked grant approved identity cannot change';
    END IF;
  END IF;

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
AFTER INSERT OR UPDATE OF class_membership_id, student_profile_id, scope, revoked_at
ON data_sharing_grants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_active_data_sharing_grant();

CREATE FUNCTION enforce_membership_active_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    NEW.student_profile_id IS DISTINCT FROM OLD.student_profile_id
    OR NEW.class_id IS DISTINCT FROM OLD.class_id
    OR NEW.state <> 'active'
  ) AND EXISTS (
    SELECT 1
    FROM data_sharing_grants AS sharing_grant
    WHERE sharing_grant.class_membership_id = OLD.id
      AND sharing_grant.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a membership with an active grant must remain active for the same student';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER class_memberships_active_grants_integrity
AFTER UPDATE OF state, class_id, student_profile_id
ON class_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_membership_active_grants();

CREATE FUNCTION enforce_class_active_grant_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id AND EXISTS (
    SELECT 1
    FROM class_memberships AS membership
    INNER JOIN data_sharing_grants AS sharing_grant
      ON sharing_grant.class_membership_id = membership.id
      AND sharing_grant.student_profile_id = membership.student_profile_id
    WHERE membership.class_id = NEW.id
      AND membership.state = 'active'
      AND sharing_grant.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a class with an active grant cannot change owner';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER classes_active_grants_owner_integrity
AFTER UPDATE OF teacher_profile_id
ON classes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_class_active_grant_owner();
