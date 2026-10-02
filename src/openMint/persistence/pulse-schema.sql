-- Additive Pulse candidate migration. Explicit installation only; historical
-- profile, authorization and wallet payloads retain their existing meaning.
BEGIN;
ALTER TABLE open_mint.generative_input_profiles DROP CONSTRAINT generative_input_profiles_profile_check;
ALTER TABLE open_mint.generative_input_profiles ADD CONSTRAINT generative_input_profiles_profile_check
  CHECK(profile IN ('sg-generative-inputs-experimental-1','sg-generative-inputs-v1-rc1','sg-generative-pulse-inputs-v1-rc1'));
CREATE TABLE open_mint.pulse_profiles (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL,
  version text NOT NULL CHECK(version='sg-pulse-pipeline-v1'),
  candidate_lock_sha256 text NOT NULL CHECK(candidate_lock_sha256 ~ '^[0-9a-f]{64}$'),
  sale_config_hash text NOT NULL CHECK(sale_config_hash ~ '^0x[0-9a-f]{64}$'),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 4194304),
  PRIMARY KEY(namespace_id,deployment_id),
  FOREIGN KEY(namespace_id,deployment_id) REFERENCES open_mint.generative_input_profiles
);
CREATE TABLE open_mint.pulse_intents (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL, request_id uuid NOT NULL,
  mint_mode smallint NOT NULL CHECK(mint_mode IN (0,1)),
  slot_id numeric(78,0) NOT NULL CHECK(slot_id>=0 AND slot_id<2::numeric^256),
  max_price numeric(78,0) NOT NULL CHECK(max_price>=0 AND max_price<2::numeric^256),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 16384),
  PRIMARY KEY(namespace_id,request_id), UNIQUE(namespace_id,deployment_id,request_id),
  FOREIGN KEY(namespace_id,deployment_id) REFERENCES open_mint.pulse_profiles,
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.requests DEFERRABLE INITIALLY DEFERRED,
  CHECK((mint_mode=0 AND slot_id<2::numeric^256-1 AND max_price=0) OR (mint_mode=1 AND slot_id=2::numeric^256-1))
);
CREATE TABLE open_mint.pulse_slot_heads (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL, slot_id numeric(78,0) NOT NULL,
  request_id uuid NOT NULL,
  PRIMARY KEY(namespace_id,deployment_id,slot_id), UNIQUE(namespace_id,request_id),
  FOREIGN KEY(namespace_id,deployment_id,request_id) REFERENCES open_mint.pulse_intents(namespace_id,deployment_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE open_mint.pulse_sponsorships (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL, slot_id numeric(78,0) NOT NULL,
  request_id uuid NOT NULL, attempt_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace_id,deployment_id,slot_id),
  FOREIGN KEY(namespace_id,deployment_id,request_id) REFERENCES open_mint.pulse_intents(namespace_id,deployment_id,request_id),
  FOREIGN KEY(namespace_id,attempt_id) REFERENCES open_mint.assessment_attempts
);
CREATE TABLE open_mint.pulse_intent_releases (
  namespace_id uuid NOT NULL, request_id uuid NOT NULL, reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace_id,request_id),
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.pulse_intents,
  CHECK(reason IN ('cancelled-before-dispatch','accepted-phase-change','finalized-authority-retired'))
);
CREATE FUNCTION open_mint.pulse_guard_slot_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'DELETE' OR NOT EXISTS(SELECT 1 FROM open_mint.pulse_intent_releases
    WHERE namespace_id=OLD.namespace_id AND request_id=OLD.request_id) THEN
    RAISE EXCEPTION 'slot release requires durable reconciliation' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END;
$$;
CREATE FUNCTION open_mint.pulse_guard_slot_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM open_mint.pulse_intents i WHERE
    i.namespace_id=NEW.namespace_id AND i.deployment_id=NEW.deployment_id
    AND i.request_id=NEW.request_id AND i.mint_mode=0 AND i.slot_id=NEW.slot_id)
    OR EXISTS(SELECT 1 FROM open_mint.pulse_intent_releases x WHERE
      x.namespace_id=NEW.namespace_id AND x.request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'slot binding requires an active free intent' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='pulse_sponsorships' THEN
    IF NOT EXISTS(SELECT 1 FROM open_mint.requests r
      WHERE r.namespace_id=NEW.namespace_id AND r.request_id=NEW.request_id AND r.attempt_id=NEW.attempt_id) THEN
      RAISE EXCEPTION 'sponsorship must bind the original request attempt' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION open_mint.pulse_guard_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reason IN ('cancelled-before-dispatch','accepted-phase-change') THEN
    IF EXISTS(SELECT 1 FROM open_mint.generative_authorizations a WHERE a.namespace_id=NEW.namespace_id AND a.request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'signing authority must be reconciled before release' USING ERRCODE='55000';
    END IF;
    IF NEW.reason='cancelled-before-dispatch' AND EXISTS(SELECT 1 FROM open_mint.requests r
      JOIN open_mint.dispatch_fences d USING(namespace_id,attempt_id)
      WHERE r.namespace_id=NEW.namespace_id AND r.request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'started provider work cannot be cancelled' USING ERRCODE='55000';
    END IF;
    IF NEW.reason='accepted-phase-change' AND NOT EXISTS(SELECT 1 FROM open_mint.requests r
      JOIN open_mint.assessments a USING(namespace_id,handle)
      WHERE r.namespace_id=NEW.namespace_id AND r.request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'phase change requires an accepted assessment' USING ERRCODE='55000';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM open_mint.generative_recoveries e
    JOIN open_mint.generative_issuance_profiles p USING(namespace_id,deployment_id)
    WHERE e.namespace_id=NEW.namespace_id AND e.request_id=NEW.request_id AND NOT p.enabled) THEN
    RAISE EXCEPTION 'release requires finalized operator recovery' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_pulse_profile BEFORE UPDATE OR DELETE ON open_mint.pulse_profiles FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_pulse_intent BEFORE UPDATE OR DELETE ON open_mint.pulse_intents FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER guard_pulse_slot_head BEFORE UPDATE OR DELETE ON open_mint.pulse_slot_heads FOR EACH ROW EXECUTE FUNCTION open_mint.pulse_guard_slot_delete();
CREATE TRIGGER immutable_pulse_sponsorship BEFORE UPDATE OR DELETE ON open_mint.pulse_sponsorships FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_pulse_release BEFORE UPDATE OR DELETE ON open_mint.pulse_intent_releases FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER bind_pulse_slot BEFORE INSERT ON open_mint.pulse_slot_heads FOR EACH ROW EXECUTE FUNCTION open_mint.pulse_guard_slot_binding();
CREATE TRIGGER bind_pulse_sponsorship BEFORE INSERT ON open_mint.pulse_sponsorships FOR EACH ROW EXECUTE FUNCTION open_mint.pulse_guard_slot_binding();
CREATE TRIGGER guard_pulse_release BEFORE INSERT ON open_mint.pulse_intent_releases FOR EACH ROW EXECUTE FUNCTION open_mint.pulse_guard_release();
REVOKE ALL ON open_mint.pulse_profiles,open_mint.pulse_intents,open_mint.pulse_slot_heads,open_mint.pulse_sponsorships,open_mint.pulse_intent_releases FROM PUBLIC;
REVOKE ALL ON FUNCTION open_mint.pulse_guard_slot_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION open_mint.pulse_guard_slot_binding(),open_mint.pulse_guard_release() FROM PUBLIC;
COMMIT;
