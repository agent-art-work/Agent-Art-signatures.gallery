-- R4 staging-only v2 migration. Explicit offline operator execution, not startup.
-- Apply only to an externally certified, paused v1 database after site drain.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
DO $$ BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(1936152941,17) THEN
    RAISE EXCEPTION 'writer must be stopped for staging recovery migration' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM open_mint.namespaces n JOIN open_mint.session_profiles s USING(namespace_id)
    JOIN open_mint.request_profiles r USING(namespace_id)
    JOIN open_mint.budget_policies b USING(namespace_id)
    JOIN open_mint.generative_issuance_profiles i USING(namespace_id,deployment_id)
    WHERE n.profile='staging-testnet' AND n.provenance='grok' AND s.chain_id=11155111
      AND s.origin='https://staging.signatures.gallery' AND r.chain_id=11155111
      AND NOT b.generation_enabled AND NOT i.enabled)
    OR EXISTS(SELECT 1 FROM open_mint.namespaces WHERE profile<>'staging-testnet')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='open_mint' AND c.relname IN ('generative_recoveries','staging_generative_recoveries'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='open_mint' AND p.proname IN ('guard_generative_retirement','guard_generative_recovery_insert')) THEN
    RAISE EXCEPTION 'not a paused, supported staging v1 source' USING ERRCODE='55000';
  END IF;
END $$;

CREATE TABLE open_mint.staging_generative_recoveries (
  namespace_id uuid NOT NULL, recovery_id uuid NOT NULL, deployment_id uuid NOT NULL,
  authorization_id uuid NOT NULL, request_id uuid NOT NULL,
  authorization_digest text NOT NULL CHECK(authorization_digest ~ '^0x[0-9a-f]{64}$'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
  approval_revision text NOT NULL CHECK(approval_revision ~ '^[0-9a-f]{64}$'),
  target_digest text NOT NULL CHECK(target_digest ~ '^[0-9a-f]{64}$'),
  database_binding text NOT NULL CHECK(database_binding ~ '^[0-9a-f]{64}$'),
  active_policy_digest text NOT NULL CHECK(active_policy_digest ~ '^[0-9a-f]{64}$'),
  operator_reference text NOT NULL CHECK(length(operator_reference) BETWEEN 3 AND 128),
  evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 3 AND 128),
  finalized_number numeric(78,0) NOT NULL CHECK(finalized_number >= 0),
  finalized_hash text NOT NULL CHECK(finalized_hash ~ '^0x[0-9a-f]{64}$'),
  finalized_timestamp numeric(20,0) NOT NULL CHECK(finalized_timestamp > 0),
  latest_number numeric(78,0) NOT NULL CHECK(latest_number >= finalized_number),
  latest_hash text NOT NULL CHECK(latest_hash ~ '^0x[0-9a-f]{64}$'),
  latest_timestamp numeric(20,0) NOT NULL CHECK(latest_timestamp >= finalized_timestamp),
  source_ids text[] NOT NULL CHECK(pg_catalog.array_length(source_ids,1)=2),
  observed_at timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK(valid_until > observed_at),
  evidence bytea NOT NULL CHECK(pg_catalog.octet_length(evidence) BETWEEN 1 AND 16384),
  owner_epoch bigint NOT NULL CHECK(owner_epoch > 0),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(namespace_id,recovery_id), UNIQUE(namespace_id,authorization_id),
  FOREIGN KEY(namespace_id,authorization_id) REFERENCES open_mint.generative_authorizations,
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.requests
);

CREATE FUNCTION open_mint.staging_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; held boolean;
BEGIN
  SELECT g.*,h.authorization_id IS NOT NULL AS active, n.profile,n.provenance,
    r.chain_id,b.generation_enabled,i.enabled INTO a
  FROM open_mint.generative_authorizations g
  JOIN open_mint.generative_authorization_heads h USING(namespace_id,deployment_id,handle,authorization_id)
  JOIN open_mint.namespaces n USING(namespace_id)
  JOIN open_mint.request_profiles r USING(namespace_id,deployment_id)
  JOIN open_mint.budget_policies b USING(namespace_id)
  JOIN open_mint.generative_issuance_profiles i USING(namespace_id,deployment_id)
  WHERE g.namespace_id=NEW.namespace_id AND g.deployment_id=NEW.deployment_id
    AND g.authorization_id=NEW.authorization_id AND g.request_id=NEW.request_id
  FOR SHARE OF b,i;
  SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
    AND pid=pg_catalog.pg_backend_pid() AND classid=1936152941::oid AND objid=17::oid
    AND objsubid=2 AND granted) INTO held;
  IF a IS NULL OR a.profile<>'staging-testnet' OR a.provenance<>'grok'
    OR a.chain_id<>11155111 OR a.generation_enabled OR a.enabled
    OR a.authorization_digest<>NEW.authorization_digest
    OR NEW.finalized_timestamp<=a.deadline OR EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())<=a.deadline
    OR NEW.valid_until<=pg_catalog.clock_timestamp() OR NEW.observed_at>pg_catalog.clock_timestamp()
    OR NEW.owner_epoch<>(SELECT epoch FROM open_mint.writer_epoch WHERE singleton=true)
    OR NOT held THEN
    RAISE EXCEPTION 'staging retirement requires disabled, expired, fenced authority' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION open_mint.staging_retirement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ns uuid; dep uuid; auth uuid; req uuid;
BEGIN
  IF TG_TABLE_NAME='wallet_mint_plans' THEN
    IF TG_OP<>'UPDATE' OR NOT OLD.nonce_active OR NEW.nonce_active
      OR (pg_catalog.to_jsonb(NEW)-'nonce_active') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'nonce_active') THEN
      RAISE EXCEPTION 'immutable wallet plan' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP<>'DELETE' THEN
    RAISE EXCEPTION 'immutable authorization head' USING ERRCODE='55000';
  END IF;
  ns:=OLD.namespace_id; dep:=OLD.deployment_id; auth:=OLD.authorization_id;
  IF TG_TABLE_NAME='wallet_mint_plans' THEN req:=OLD.request_id; END IF;
  IF NOT EXISTS(SELECT 1 FROM open_mint.staging_generative_recoveries e
    JOIN open_mint.budget_policies b USING(namespace_id)
    JOIN open_mint.generative_issuance_profiles i USING(namespace_id,deployment_id)
    WHERE e.namespace_id=ns AND e.deployment_id=dep AND e.authorization_id=auth
    AND (req IS NULL OR e.request_id=req) AND NOT b.generation_enabled AND NOT i.enabled
    AND e.valid_until>pg_catalog.clock_timestamp()
    AND e.owner_epoch=(SELECT epoch FROM open_mint.writer_epoch WHERE singleton=true)
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
      AND pid=pg_catalog.pg_backend_pid() AND classid=1936152941::oid AND objid=17::oid
      AND objsubid=2 AND granted)) THEN
    RAISE EXCEPTION 'retirement requires exact durable evidence' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION open_mint.staging_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.valid_until<=pg_catalog.clock_timestamp()
    OR NEW.owner_epoch<>(SELECT epoch FROM open_mint.writer_epoch WHERE singleton=true)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
      AND pid=pg_catalog.pg_backend_pid() AND classid=1936152941::oid AND objid=17::oid AND objsubid=2 AND granted)
    OR EXISTS(SELECT 1 FROM open_mint.budget_policies b JOIN open_mint.generative_issuance_profiles i USING(namespace_id)
      WHERE b.namespace_id=NEW.namespace_id AND i.deployment_id=NEW.deployment_id AND (b.generation_enabled OR i.enabled))
    OR EXISTS(SELECT 1 FROM open_mint.generative_authorization_heads h
    WHERE h.namespace_id=NEW.namespace_id AND h.deployment_id=NEW.deployment_id
    AND h.authorization_id=NEW.authorization_id)
    OR EXISTS(SELECT 1 FROM open_mint.wallet_mint_plans p
      WHERE p.namespace_id=NEW.namespace_id AND p.authorization_id=NEW.authorization_id
      AND (p.request_id<>NEW.request_id OR p.nonce_active)) THEN
    RAISE EXCEPTION 'incomplete staging retirement' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER guard_staging_recovery BEFORE INSERT ON open_mint.staging_generative_recoveries
  FOR EACH ROW EXECUTE FUNCTION open_mint.staging_recovery_guard();
CREATE CONSTRAINT TRIGGER complete_staging_recovery AFTER INSERT ON open_mint.staging_generative_recoveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION open_mint.staging_recovery_complete();
CREATE TRIGGER immutable_staging_recovery BEFORE UPDATE OR DELETE ON open_mint.staging_generative_recoveries
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
DROP TRIGGER immutable_authorization_head ON open_mint.generative_authorization_heads;
CREATE TRIGGER immutable_authorization_head BEFORE UPDATE OR DELETE ON open_mint.generative_authorization_heads
  FOR EACH ROW EXECUTE FUNCTION open_mint.staging_retirement_mutation();
DROP TRIGGER immutable_wallet_plan ON open_mint.wallet_mint_plans;
CREATE TRIGGER immutable_wallet_plan BEFORE UPDATE OR DELETE ON open_mint.wallet_mint_plans
  FOR EACH ROW EXECUTE FUNCTION open_mint.staging_retirement_mutation();
REVOKE ALL ON open_mint.staging_generative_recoveries FROM PUBLIC;
REVOKE ALL ON FUNCTION open_mint.staging_recovery_guard(),open_mint.staging_retirement_mutation(),open_mint.staging_recovery_complete() FROM PUBLIC;
COMMIT;
