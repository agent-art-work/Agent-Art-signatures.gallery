-- Offline operator migration, AFTER wallet-submission-schema.sql. Never startup.
-- Stop/drain the site, disable issuance, and release its writer before use.
BEGIN;
-- Upgrade the previous immutable-plan schema without deleting any evidence.
ALTER TABLE open_mint.wallet_mint_plans ADD COLUMN IF NOT EXISTS nonce_active boolean NOT NULL DEFAULT true;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.conname FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='open_mint.wallet_mint_plans'::regclass AND c.contype='u'
    AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM unnest(c.conkey) k
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k)
      = ARRAY['deployment_id','namespace_id','recipient','wallet_nonce']::text[]
  LOOP EXECUTE format('ALTER TABLE open_mint.wallet_mint_plans DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_mint_active_nonce ON open_mint.wallet_mint_plans(namespace_id,deployment_id,lower(recipient),wallet_nonce) WHERE nonce_active;
CREATE OR REPLACE FUNCTION open_mint.guard_wallet_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.nonce_active THEN RAISE EXCEPTION 'new wallet nonce must be active' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_wallet_plan_insert ON open_mint.wallet_mint_plans;
CREATE TRIGGER guard_wallet_plan_insert BEFORE INSERT ON open_mint.wallet_mint_plans FOR EACH ROW EXECUTE FUNCTION open_mint.guard_wallet_plan_insert();

CREATE TABLE open_mint.generative_recoveries (
  namespace_id uuid NOT NULL, recovery_id uuid NOT NULL, deployment_id uuid NOT NULL,
  authorization_id uuid NOT NULL, request_id uuid NOT NULL,
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
  finalized_number numeric(78,0) NOT NULL CHECK(finalized_number >= 0),
  finalized_hash text NOT NULL CHECK(finalized_hash ~ '^0x[0-9a-f]{64}$'),
  finalized_timestamp numeric(20,0) NOT NULL CHECK(finalized_timestamp > 0),
  evidence bytea NOT NULL CHECK(octet_length(evidence) BETWEEN 1 AND 16384),
  owner_epoch bigint NOT NULL CHECK(owner_epoch > 0), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace_id,recovery_id), UNIQUE(namespace_id,authorization_id),
  FOREIGN KEY(namespace_id,authorization_id) REFERENCES open_mint.generative_authorizations,
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.requests
);
CREATE FUNCTION open_mint.guard_generative_recovery_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM open_mint.generative_authorizations a
    JOIN open_mint.generative_authorization_heads h USING(namespace_id,deployment_id,handle,authorization_id)
    JOIN open_mint.generative_issuance_profiles p USING(namespace_id,deployment_id)
    JOIN open_mint.request_profiles r USING(namespace_id,deployment_id)
    JOIN open_mint.namespaces n USING(namespace_id)
    WHERE a.namespace_id=NEW.namespace_id AND a.authorization_id=NEW.authorization_id
    AND a.deployment_id=NEW.deployment_id AND a.request_id=NEW.request_id
    AND NOT p.enabled AND r.chain_id=31337 AND n.profile='local-real' AND n.provenance='grok'
    AND NEW.finalized_timestamp > a.deadline AND extract(epoch FROM clock_timestamp()) > a.deadline)
    OR NOT EXISTS(SELECT 1 FROM open_mint.writer_epoch WHERE epoch=NEW.owner_epoch) THEN
    RAISE EXCEPTION 'recovery requires disabled isolated issuance and expired authority' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION open_mint.guard_generative_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ns uuid; dep uuid; auth uuid;
BEGIN
  IF TG_TABLE_NAME='wallet_mint_plans' THEN
    IF TG_OP<>'UPDATE' OR NOT OLD.nonce_active OR NEW.nonce_active
      OR (to_jsonb(NEW)-'nonce_active') IS DISTINCT FROM (to_jsonb(OLD)-'nonce_active') THEN
      RAISE EXCEPTION 'immutable wallet plan' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP<>'DELETE' THEN
    RAISE EXCEPTION 'immutable authorization head' USING ERRCODE='55000';
  END IF;
  ns:=OLD.namespace_id; dep:=OLD.deployment_id; auth:=OLD.authorization_id;
  IF NOT EXISTS(SELECT 1 FROM open_mint.generative_recoveries e
    JOIN open_mint.generative_issuance_profiles p USING(namespace_id,deployment_id)
    WHERE e.namespace_id=ns AND e.deployment_id=dep AND e.authorization_id=auth AND NOT p.enabled) THEN
    RAISE EXCEPTION 'retirement requires durable operator evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_generative_recovery_insert BEFORE INSERT ON open_mint.generative_recoveries FOR EACH ROW EXECUTE FUNCTION open_mint.guard_generative_recovery_insert();
CREATE TRIGGER immutable_generative_recovery BEFORE UPDATE OR DELETE ON open_mint.generative_recoveries FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
DROP TRIGGER immutable_authorization_head ON open_mint.generative_authorization_heads;
CREATE TRIGGER immutable_authorization_head BEFORE UPDATE OR DELETE ON open_mint.generative_authorization_heads FOR EACH ROW EXECUTE FUNCTION open_mint.guard_generative_retirement();
DROP TRIGGER immutable_wallet_plan ON open_mint.wallet_mint_plans;
CREATE TRIGGER immutable_wallet_plan BEFORE UPDATE OR DELETE ON open_mint.wallet_mint_plans FOR EACH ROW EXECUTE FUNCTION open_mint.guard_generative_retirement();
REVOKE ALL ON open_mint.generative_recoveries FROM PUBLIC;
REVOKE ALL ON FUNCTION open_mint.guard_generative_recovery_insert(),open_mint.guard_generative_retirement(),open_mint.guard_wallet_plan_insert() FROM PUBLIC;
COMMIT;
