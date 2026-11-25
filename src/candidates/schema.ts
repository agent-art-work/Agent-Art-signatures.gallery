// This schema belongs to the new candidate profile. Never apply it to a pilot owner.
export const CANDIDATE_DDL = [`
CREATE TABLE IF NOT EXISTS curve_attempts (
  encounter TEXT PRIMARY KEY,
  work_instance TEXT UNIQUE NOT NULL,
  definition TEXT NOT NULL,
  policy TEXT NOT NULL,
  curator TEXT NOT NULL,
  agent TEXT NOT NULL,
  handle TEXT NOT NULL,
  handle_key TEXT NOT NULL,
  original_svg TEXT NOT NULL,
  original_sha TEXT NOT NULL,
  original_points TEXT NOT NULL,
  candidate_format INTEGER NOT NULL DEFAULT 1 CHECK (candidate_format IN (1, 2)),
  posts_json TEXT,
  local_state TEXT NOT NULL DEFAULT 'open' CHECK (local_state IN ('open', 'saved', 'declined')),
  draft_digest TEXT,
  edit_json TEXT,
  intention TEXT,
  final_svg TEXT,
  final_sha TEXT,
  approved_digest TEXT,
  approved_at TEXT,
  write_until TEXT,
  recover_until TEXT,
  operation_id TEXT,
  receipt_json TEXT,
  accepted_at TEXT,
  envelope_json TEXT,
  envelope_sha TEXT,
  CHECK ((approved_digest IS NULL) = (approved_at IS NULL)),
  CHECK ((approved_at IS NULL) = (write_until IS NULL)),
  CHECK ((approved_at IS NULL) = (recover_until IS NULL)),
  CHECK (approved_at IS NULL OR (approved_at < write_until AND write_until < recover_until)),
  CHECK ((operation_id IS NULL) = (envelope_json IS NULL)),
  CHECK ((operation_id IS NULL) = (envelope_sha IS NULL)),
  CHECK (approved_digest IS NULL OR (draft_digest IS NOT NULL AND approved_digest = draft_digest)),
  CHECK ((operation_id IS NULL) = (receipt_json IS NULL)),
  CHECK ((operation_id IS NULL) = (accepted_at IS NULL)),
  CHECK (operation_id IS NULL OR (approved_digest IS NOT NULL AND intention IS NOT NULL AND final_svg IS NOT NULL AND final_sha IS NOT NULL))
) STRICT;`, `
CREATE TABLE IF NOT EXISTS curve_gallery (
  sequence INTEGER PRIMARY KEY,
  candidate_id TEXT UNIQUE NOT NULL REFERENCES curve_attempts(encounter),
  handle TEXT NOT NULL,
  handle_key TEXT NOT NULL,
  intention TEXT NOT NULL,
  svg TEXT NOT NULL,
  svg_sha TEXT NOT NULL,
  draft_digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL
) STRICT;`, `
CREATE INDEX IF NOT EXISTS curve_gallery_by_handle ON curve_gallery(handle_key, sequence DESC);`, `
CREATE TABLE IF NOT EXISTS curve_outbox (
  sequence INTEGER PRIMARY KEY,
  candidate_id TEXT UNIQUE NOT NULL REFERENCES curve_attempts(encounter),
  envelope_sha TEXT NOT NULL,
  published_at TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1))
) STRICT;`, `
CREATE TABLE IF NOT EXISTS curve_restrictions (
  encounter TEXT NOT NULL REFERENCES curve_attempts(encounter),
  right_name TEXT NOT NULL CHECK (right_name IN ('write', 'recovery', 'disclosure')),
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (encounter, right_name)
) STRICT;`, `
CREATE TABLE IF NOT EXISTS curve_winners (
  handle_key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES curve_gallery(candidate_id),
  token_id TEXT UNIQUE NOT NULL,
  transaction_hash TEXT NOT NULL,
  finalized_block TEXT NOT NULL
) STRICT;`, `
CREATE TRIGGER IF NOT EXISTS curve_queue_export
AFTER UPDATE OF receipt_json ON curve_attempts
WHEN OLD.receipt_json IS NULL AND NEW.receipt_json IS NOT NULL
BEGIN
  INSERT INTO curve_outbox(candidate_id, envelope_sha) VALUES (NEW.encounter, NEW.envelope_sha);
END;`, `
CREATE TRIGGER IF NOT EXISTS curve_project_acceptance
AFTER UPDATE OF published_at ON curve_outbox
WHEN OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
BEGIN
  INSERT INTO curve_gallery(sequence, candidate_id, handle, handle_key, intention, svg, svg_sha, draft_digest, accepted_at)
  SELECT NEW.sequence, encounter, handle, handle_key, intention, final_svg, final_sha, draft_digest, accepted_at
  FROM curve_attempts WHERE encounter = NEW.candidate_id;
END;
`];

export const CANDIDATE_SCHEMA = CANDIDATE_DDL.join("\n");

// Explicit upgrade for the isolated curve fixture's user_version=2 only.
// Legacy digests, envelopes, receipts and gallery rows are never rewritten.
export const CANDIDATE_V3_MIGRATION = `
ALTER TABLE curve_attempts ADD COLUMN candidate_format INTEGER NOT NULL DEFAULT 1 CHECK (candidate_format IN (1, 2));
ALTER TABLE curve_attempts ADD COLUMN posts_json TEXT;
ALTER TABLE curve_attempts ADD COLUMN local_state TEXT NOT NULL DEFAULT 'open' CHECK (local_state IN ('open', 'saved', 'declined'));
`;
