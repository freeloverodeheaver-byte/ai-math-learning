DROP TRIGGER data_sharing_grants_active_integrity ON data_sharing_grants;

CREATE OR REPLACE FUNCTION enforce_active_data_sharing_grant() RETURNS trigger LANGUAGE plpgsql AS $$
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
