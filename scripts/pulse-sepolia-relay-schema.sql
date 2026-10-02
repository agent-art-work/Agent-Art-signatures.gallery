-- Site-specific, derived public chain data. Apply with a migration role before
-- enabling the optional PostgreSQL relay. No signing or private assessment data.
BEGIN;
CREATE SCHEMA IF NOT EXISTS pulse_site_relay;
CREATE TABLE IF NOT EXISTS pulse_site_relay.deployments (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  pins jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pulse_site_relay.checkpoints (
  deployment_id text PRIMARY KEY REFERENCES pulse_site_relay.deployments(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  head_number bigint NOT NULL CHECK (head_number >= 0),
  head_hash text NOT NULL CHECK (head_hash ~ '^0x[0-9a-f]{64}$'),
  head_timestamp bigint NOT NULL CHECK (head_timestamp >= 0),
  finalized_number bigint NOT NULL CHECK (finalized_number >= 0),
  finalized_hash text NOT NULL CHECK (finalized_hash ~ '^0x[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL,
  expected_mint_count integer NOT NULL CHECK (expected_mint_count >= 0),
  observed_mint_count integer NOT NULL CHECK (observed_mint_count >= 0),
  source text NOT NULL CHECK (source IN ('primary','secondary')),
  CHECK (finalized_number <= head_number),
  CHECK (expected_mint_count = observed_mint_count)
);
CREATE TABLE IF NOT EXISTS pulse_site_relay.works (
  deployment_id text NOT NULL REFERENCES pulse_site_relay.deployments(id),
  handle text NOT NULL CHECK (handle ~ '^[a-z0-9_]{1,15}$'),
  token_id numeric(78,0) NOT NULL,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('confirming','minted')),
  payload jsonb NOT NULL,
  PRIMARY KEY (deployment_id,handle), UNIQUE (deployment_id,token_id)
);
CREATE INDEX IF NOT EXISTS pulse_site_relay_works_order ON pulse_site_relay.works(deployment_id,block_number DESC,handle);
CREATE TABLE IF NOT EXISTS pulse_site_relay.artworks (
  deployment_id text NOT NULL REFERENCES pulse_site_relay.deployments(id),
  key text NOT NULL CHECK (key ~ '^0x[0-9a-f]{64}:0x[0-9a-f]{64}$'),
  svg text NOT NULL CHECK (octet_length(svg) BETWEEN 1 AND 16384),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (deployment_id,key)
);
CREATE TABLE IF NOT EXISTS pulse_site_relay.ownership (
  deployment_id text PRIMARY KEY REFERENCES pulse_site_relay.deployments(id),
  head_number bigint NOT NULL CHECK (head_number >= 0),
  head_hash text NOT NULL CHECK (head_hash ~ '^0x[0-9a-f]{64}$'),
  finalized_number bigint NOT NULL CHECK (finalized_number >= 0),
  finalized_hash text NOT NULL CHECK (finalized_hash ~ '^0x[0-9a-f]{64}$'),
  owners jsonb NOT NULL,
  finalized_owners jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('primary','secondary')),
  CHECK (finalized_number <= head_number)
);
CREATE TABLE IF NOT EXISTS pulse_site_relay.observations (
  deployment_id text NOT NULL REFERENCES pulse_site_relay.deployments(id),
  revision bigint NOT NULL,
  head_number bigint NOT NULL,
  head_hash text NOT NULL,
  finalized_number bigint NOT NULL,
  finalized_hash text NOT NULL,
  source text NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (deployment_id,revision)
);
REVOKE ALL ON SCHEMA pulse_site_relay FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pulse_site_relay FROM PUBLIC;
COMMIT;
