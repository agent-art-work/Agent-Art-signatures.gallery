-- Experimental input-only issuance, after schema.sql, requests-schema.sql and generative-input-schema.sql.
-- Explicit operator migration only; no public enablement or old-token mutation.
BEGIN;
CREATE TABLE open_mint.generative_issuance_profiles (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  lifetime_seconds integer NOT NULL CHECK(lifetime_seconds BETWEEN 16 AND 900),
  signer_timeout_ms integer NOT NULL CHECK(signer_timeout_ms BETWEEN 1 AND 30000),
  max_evidence_age_ms integer NOT NULL CHECK(max_evidence_age_ms BETWEEN 1 AND 60000),
  max_block_age_ms integer NOT NULL CHECK(max_block_age_ms BETWEEN 1 AND 3600000),
  max_future_skew_ms integer NOT NULL CHECK(max_future_skew_ms BETWEEN 0 AND 300000),
  PRIMARY KEY(namespace_id,deployment_id),
  FOREIGN KEY(namespace_id,deployment_id) REFERENCES open_mint.generative_input_profiles
);
CREATE TABLE open_mint.generative_authorizations (
  namespace_id uuid NOT NULL, authorization_id uuid NOT NULL, deployment_id uuid NOT NULL,
  handle text NOT NULL, request_id uuid NOT NULL, session_hash text NOT NULL,
  session_generation bigint NOT NULL CHECK(session_generation >= 0),
  recipient text NOT NULL CHECK(recipient ~ '^0x[0-9A-Fa-f]{40}$'),
  assessment_id uuid NOT NULL, input_digest text NOT NULL,
  nonce text NOT NULL CHECK(nonce ~ '^0x[0-9a-f]{64}$'),
  authorization_digest text NOT NULL CHECK(authorization_digest ~ '^0x[0-9a-f]{64}$'),
  issued_at numeric(20,0) NOT NULL CHECK(issued_at > 0), deadline numeric(20,0) NOT NULL,
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 131072),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','signing','unknown','signed')),
  signing_epoch bigint CHECK(signing_epoch > 0),
  PRIMARY KEY(namespace_id,authorization_id),
  UNIQUE(namespace_id,deployment_id,nonce), UNIQUE(namespace_id,deployment_id,authorization_digest),
  UNIQUE(namespace_id,deployment_id,handle,authorization_id),
  FOREIGN KEY(namespace_id,deployment_id) REFERENCES open_mint.generative_issuance_profiles,
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.requests,
  FOREIGN KEY(namespace_id,session_hash) REFERENCES open_mint.sessions,
  FOREIGN KEY(namespace_id,handle,assessment_id) REFERENCES open_mint.assessments(namespace_id,handle,assessment_id),
  FOREIGN KEY(namespace_id,deployment_id,input_digest) REFERENCES open_mint.generative_inputs(namespace_id,deployment_id,digest),
  CHECK(deadline > issued_at AND deadline-issued_at <= 900),
  CHECK((state='reserved') = (signing_epoch IS NULL))
);
CREATE TABLE open_mint.generative_authorization_heads (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL, handle text NOT NULL,
  authorization_id uuid NOT NULL,
  PRIMARY KEY(namespace_id,deployment_id,handle),
  FOREIGN KEY(namespace_id,deployment_id,handle,authorization_id) REFERENCES open_mint.generative_authorizations(namespace_id,deployment_id,handle,authorization_id)
);
CREATE TABLE open_mint.generative_authorization_signatures (
  namespace_id uuid NOT NULL, authorization_id uuid NOT NULL,
  signature text NOT NULL CHECK(signature ~ '^0x[0-9a-f]{130}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace_id,authorization_id),
  FOREIGN KEY(namespace_id,authorization_id) REFERENCES open_mint.generative_authorizations
);
CREATE FUNCTION open_mint.generative_guard_issuance_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled') THEN
    RAISE EXCEPTION 'immutable issuance profile' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION open_mint.generative_guard_authorization_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'state'-'signing_epoch') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'signing_epoch') THEN
    RAISE EXCEPTION 'immutable authorization reservation' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='reserved' AND NEW.state='signing' AND NEW.signing_epoch IS NOT NULL)
    OR (OLD.state='signing' AND NEW.state IN ('unknown','signed') AND NEW.signing_epoch=OLD.signing_epoch)) THEN
    RAISE EXCEPTION 'invalid authorization transition' USING ERRCODE='55000';
  END IF;
  IF NEW.state='signed' AND NOT EXISTS(SELECT 1 FROM open_mint.generative_authorization_signatures WHERE namespace_id=NEW.namespace_id AND authorization_id=NEW.authorization_id) THEN
    RAISE EXCEPTION 'signed state requires durable signature' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION open_mint.generative_guard_signature_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM open_mint.generative_authorizations WHERE namespace_id=NEW.namespace_id AND authorization_id=NEW.authorization_id AND state IN ('signing','signed')) THEN
    RAISE EXCEPTION 'signature requires a committed signing fence' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_issuance_profile BEFORE UPDATE OR DELETE ON open_mint.generative_issuance_profiles FOR EACH ROW EXECUTE FUNCTION open_mint.generative_guard_issuance_profile();
CREATE TRIGGER guard_authorization BEFORE UPDATE OR DELETE ON open_mint.generative_authorizations FOR EACH ROW EXECUTE FUNCTION open_mint.generative_guard_authorization_change();
CREATE TRIGGER immutable_authorization_head BEFORE UPDATE OR DELETE ON open_mint.generative_authorization_heads FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER guard_signature_insert BEFORE INSERT ON open_mint.generative_authorization_signatures FOR EACH ROW EXECUTE FUNCTION open_mint.generative_guard_signature_insert();
CREATE TRIGGER immutable_authorization_signature BEFORE UPDATE OR DELETE ON open_mint.generative_authorization_signatures FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
REVOKE ALL ON open_mint.generative_issuance_profiles,open_mint.generative_authorizations,open_mint.generative_authorization_heads,open_mint.generative_authorization_signatures FROM PUBLIC;
REVOKE ALL ON FUNCTION open_mint.generative_guard_issuance_profile(),open_mint.generative_guard_authorization_change(),open_mint.generative_guard_signature_insert() FROM PUBLIC;
COMMIT;
