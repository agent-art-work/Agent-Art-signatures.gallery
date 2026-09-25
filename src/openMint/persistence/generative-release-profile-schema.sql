-- Explicit additive upgrade. Never relabel existing profiles or payloads.
-- The service still refuses public issuance/startup. No automatic migration.
BEGIN;
ALTER TABLE open_mint.generative_input_profiles DROP CONSTRAINT generative_input_profiles_profile_check;
ALTER TABLE open_mint.generative_input_profiles ADD CONSTRAINT generative_input_profiles_profile_check
  CHECK (profile IN ('sg-generative-inputs-experimental-1','sg-generative-inputs-v1-rc1'));
COMMIT;
