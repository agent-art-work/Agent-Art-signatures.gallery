-- Explicit additive migration. No existing artifacts, assessments or tokens change.
-- This experimental profile must only be configured for isolated local Anvil.
BEGIN;
CREATE TABLE open_mint.generative_input_profiles (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL,
  profile text NOT NULL CHECK(profile='sg-generative-inputs-experimental-1'),
  renderer_address text NOT NULL CHECK(renderer_address ~ '^0x[0-9A-Fa-f]{40}$'),
  renderer_code_hash text NOT NULL CHECK(renderer_code_hash ~ '^0x[0-9a-f]{64}$'),
  renderer_identity text NOT NULL CHECK(renderer_identity ~ '^0x[0-9a-f]{64}$'),
  PRIMARY KEY(namespace_id,deployment_id),
  FOREIGN KEY(namespace_id,deployment_id) REFERENCES open_mint.request_profiles
);
CREATE TABLE open_mint.generative_inputs (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL, handle text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^0x[0-9a-f]{64}$'),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 65536),
  PRIMARY KEY(namespace_id,deployment_id,digest), UNIQUE(namespace_id,deployment_id,handle),
  FOREIGN KEY(namespace_id,deployment_id) REFERENCES open_mint.generative_input_profiles,
  FOREIGN KEY(namespace_id,handle) REFERENCES open_mint.assessments
);
CREATE TRIGGER immutable_generative_input_profile BEFORE UPDATE OR DELETE ON open_mint.generative_input_profiles
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_generative_input BEFORE UPDATE OR DELETE ON open_mint.generative_inputs
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
REVOKE ALL ON open_mint.generative_input_profiles,open_mint.generative_inputs FROM PUBLIC;
COMMIT;
