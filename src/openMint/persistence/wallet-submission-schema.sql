-- Explicit isolated-generative extension. Never run automatically at startup.
-- A browser report is not chain evidence. No report can delete a dispatch.
BEGIN;
CREATE TABLE open_mint.wallet_mint_plans (
  namespace_id uuid NOT NULL, deployment_id uuid NOT NULL, request_id uuid NOT NULL,
  authorization_id uuid NOT NULL, recipient text NOT NULL, wallet_nonce numeric(20,0) NOT NULL CHECK(wallet_nonce >= 0),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 16384),
  nonce_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(namespace_id,request_id),
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.requests,
  FOREIGN KEY(namespace_id,authorization_id) REFERENCES open_mint.generative_authorizations
);
CREATE UNIQUE INDEX wallet_mint_active_nonce ON open_mint.wallet_mint_plans(namespace_id,deployment_id,lower(recipient),wallet_nonce) WHERE nonce_active;
CREATE FUNCTION open_mint.guard_wallet_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.nonce_active THEN RAISE EXCEPTION 'new wallet nonce must be active' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_wallet_plan_insert BEFORE INSERT ON open_mint.wallet_mint_plans FOR EACH ROW EXECUTE FUNCTION open_mint.guard_wallet_plan_insert();
CREATE TABLE open_mint.wallet_mint_dispatches (
  namespace_id uuid NOT NULL, request_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
  permit_hash text NOT NULL CHECK(permit_hash ~ '^[0-9a-f]{64}$'),
  owner_epoch bigint NOT NULL CHECK(owner_epoch > 0), dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace_id,request_id,attempt),
  FOREIGN KEY(namespace_id,request_id) REFERENCES open_mint.wallet_mint_plans
);
CREATE TABLE open_mint.wallet_mint_reports (
  namespace_id uuid NOT NULL, request_id uuid NOT NULL, attempt integer NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('submitted','rejected')), transaction_hash text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace_id,request_id,attempt),
  FOREIGN KEY(namespace_id,request_id,attempt) REFERENCES open_mint.wallet_mint_dispatches,
  CHECK((outcome='submitted' AND transaction_hash IS NOT NULL AND transaction_hash ~ '^0x[0-9a-f]{64}$') OR (outcome='rejected' AND transaction_hash IS NULL))
);
CREATE TRIGGER immutable_wallet_plan BEFORE UPDATE OR DELETE ON open_mint.wallet_mint_plans FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_wallet_dispatch BEFORE UPDATE OR DELETE ON open_mint.wallet_mint_dispatches FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_wallet_report BEFORE UPDATE OR DELETE ON open_mint.wallet_mint_reports FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
REVOKE ALL ON open_mint.wallet_mint_plans,open_mint.wallet_mint_dispatches,open_mint.wallet_mint_reports FROM PUBLIC;
REVOKE ALL ON FUNCTION open_mint.guard_wallet_plan_insert() FROM PUBLIC;
COMMIT;
