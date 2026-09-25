-- Explicit additive migration after schema.sql and requests-schema.sql.
-- New namespaces only; never rewrite historical public_artifacts/publications.
BEGIN;
CREATE TABLE open_mint.onchain_artifact_profiles (
  namespace_id uuid PRIMARY KEY REFERENCES open_mint.namespaces,
  profile text NOT NULL CHECK(profile='signatures.gallery/onchain-artifact/v1')
);
CREATE TABLE open_mint.onchain_artifacts (
  namespace_id uuid NOT NULL REFERENCES open_mint.onchain_artifact_profiles,
  handle text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^0x[0-9a-f]{64}$'),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 131072),
  PRIMARY KEY(namespace_id,digest), UNIQUE(namespace_id,handle),
  FOREIGN KEY(namespace_id,handle) REFERENCES open_mint.assessments
);
CREATE TRIGGER immutable_onchain_artifact_profile BEFORE UPDATE OR DELETE ON open_mint.onchain_artifact_profiles
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_onchain_artifact BEFORE UPDATE OR DELETE ON open_mint.onchain_artifacts
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
REVOKE ALL ON open_mint.onchain_artifact_profiles,open_mint.onchain_artifacts FROM PUBLIC;
COMMIT;
