CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE app_role AS ENUM ('student', 'guardian', 'teacher', 'operator');
CREATE TYPE review_state AS ENUM ('draft', 'in_review', 'published', 'retired');
CREATE TYPE membership_state AS ENUM ('requested', 'active', 'rejected', 'revoked');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_user_role_unique UNIQUE (user_id, role)
);

CREATE TABLE student_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 7 AND 9),
  semester smallint NOT NULL CHECK (semester IN (1, 2)),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guardian_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_profile_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX guardian_links_active_unique ON guardian_links (guardian_user_id, student_profile_id) WHERE revoked_at IS NULL;

CREATE TABLE teacher_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_profile_id uuid NOT NULL REFERENCES teacher_profiles(id) ON DELETE RESTRICT,
  name text NOT NULL,
  subject text NOT NULL,
  invite_code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE class_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_profile_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  state membership_state NOT NULL DEFAULT 'requested',
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX class_memberships_active_unique ON class_memberships (class_id, student_profile_id) WHERE state = 'active';

CREATE TABLE data_sharing_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_membership_id uuid NOT NULL REFERENCES class_memberships(id) ON DELETE CASCADE,
  student_profile_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  scope text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX data_sharing_grants_active_unique ON data_sharing_grants (class_membership_id, scope) WHERE revoked_at IS NULL;

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id text NOT NULL UNIQUE,
  name text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 7 AND 9),
  semester smallint NOT NULL CHECK (semester IN (1, 2))
);

CREATE TABLE knowledge_point_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_point_id uuid NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 7 AND 9),
  semester smallint NOT NULL CHECK (semester IN (1, 2)),
  source_id uuid REFERENCES sources(id) ON DELETE RESTRICT,
  review_state review_state NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_point_versions_version_unique UNIQUE (knowledge_point_id, version)
);

CREATE TABLE knowledge_prerequisites (
  knowledge_point_id uuid NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  prerequisite_knowledge_point_id uuid NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_prerequisites_unique UNIQUE (knowledge_point_id, prerequisite_knowledge_point_id),
  CONSTRAINT knowledge_prerequisites_not_self CHECK (knowledge_point_id <> prerequisite_knowledge_point_id)
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key text NOT NULL UNIQUE
);

CREATE TABLE question_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  stem text NOT NULL,
  answer text NOT NULL,
  explanation text NOT NULL,
  difficulty smallint CHECK (difficulty BETWEEN 1 AND 5),
  source_id uuid REFERENCES sources(id) ON DELETE RESTRICT,
  review_state review_state NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_versions_version_unique UNIQUE (question_id, version)
);

CREATE TABLE question_knowledge_points (
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  knowledge_point_id uuid NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  CONSTRAINT question_knowledge_points_unique UNIQUE (question_id, knowledge_point_id)
);

CREATE FUNCTION enforce_published_question_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_state = 'published' THEN
    IF NEW.source_id IS NULL THEN
      RAISE EXCEPTION 'published question versions require a source';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM question_knowledge_points WHERE question_id = NEW.question_id
    ) THEN
      RAISE EXCEPTION 'published question versions require a knowledge-point link';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER question_versions_published_integrity
AFTER INSERT OR UPDATE OF question_id, source_id, review_state ON question_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_published_question_version();

CREATE FUNCTION enforce_published_question_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stable_question_id uuid;
BEGIN
  stable_question_id := OLD.question_id;

  IF EXISTS (
    SELECT 1 FROM question_versions
    WHERE question_id = stable_question_id AND review_state = 'published'
  ) AND NOT EXISTS (
    SELECT 1 FROM question_knowledge_points WHERE question_id = stable_question_id
  ) THEN
    RAISE EXCEPTION 'published question versions require a knowledge-point link';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER question_knowledge_points_published_integrity
AFTER DELETE OR UPDATE OF question_id ON question_knowledge_points
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_published_question_link();

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
