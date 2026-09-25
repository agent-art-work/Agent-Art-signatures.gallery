-- Explicit additive migration from v2. Existing deployments/payloads unchanged.
BEGIN;
LOCK TABLE open_mint.projection_schema_version,open_mint.projection_logs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT count(*) FROM open_mint.projection_schema_version) <> 1
    OR NOT EXISTS(SELECT 1 FROM open_mint.projection_schema_version WHERE version=2) THEN
    RAISE EXCEPTION 'projection upgrade requires exactly schema v2' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE open_mint.projection_schema_version DROP CONSTRAINT projection_schema_version_version_check;
UPDATE open_mint.projection_schema_version SET version=3 WHERE version=2;
ALTER TABLE open_mint.projection_schema_version ADD CHECK(version=3);
ALTER TABLE open_mint.projection_logs DROP CONSTRAINT projection_logs_kind_check;
ALTER TABLE open_mint.projection_logs ADD CHECK(kind IN ('OpenSignatureMinted','GenerativeSignatureMinted','Transfer'));
COMMIT;
