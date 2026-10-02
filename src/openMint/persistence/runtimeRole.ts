/** Exact shared foundation surface. Audit and grant generation must agree;
 * extensions require a separate, reviewed capability profile. */
export const FOUNDATION_RUNTIME_PRIVILEGES = Object.freeze(([
  ["schema_version", "version", false, ""],
  ["writer_epoch", "singleton epoch", false, "epoch"],
  ["namespaces", "namespace_id profile provenance policy_version", false, ""],
  ["budget_policies", "namespace_id profile_version expected_model generation_enabled valid_until max_total max_daily max_active max_queued reservation_usd_ticks max_exposure_usd_ticks", false, "namespace_id"],
  ["handle_guards", "namespace_id handle", true, "handle"],
  ["assessment_attempts", "namespace_id attempt_id handle record_version profile_version admitted_at state", true, "state"],
  ["assessment_terminals", "namespace_id attempt_id kind reason phase owner_epoch recorded_at", true, ""],
  ["budget_reservations", "namespace_id attempt_id admitted_day reserved_usd_ticks", true, ""],
  ["jobs", "namespace_id job_id attempt_id kind state owner_epoch", true, "state owner_epoch"],
  ["dispatch_fences", "namespace_id attempt_id leg owner_epoch dispatched_at", true, ""],
  ["provider_receipts", "namespace_id attempt_id leg record_version payload cost_status cost_usd_ticks", true, ""],
  ["verified_identities", "namespace_id attempt_id payload", true, ""],
  ["assessments", "namespace_id handle assessment_id attempt_id digest payload", true, ""],
  ["session_profiles", "namespace_id origin chain_id", false, ""],
  ["sessions", "namespace_id session_hash csrf expires_at generation revoked wallet proof_wallet proof_code_hash proof_expires_at active_challenge_hash", true,
    "generation revoked wallet proof_wallet proof_code_hash proof_expires_at active_challenge_hash"],
  ["wallet_challenges", "namespace_id challenge_hash session_hash generation message wallet code_hash expires_at consumed_at", true, "consumed_at"],
] as const).map(([name, columns, insert, updates]) => Object.freeze({ name, columns: Object.freeze(columns.split(" ").sort()), insert,
  updates: Object.freeze(updates ? updates.split(" ") : []) })));

export interface RuntimeTablePrivileges { readonly name: string; readonly columns: readonly string[]; readonly insert: boolean; readonly updates: readonly string[]; readonly delete?: boolean }
/** Preparation API only. No projection/rollback, migration, operator-policy or
 * recovery privileges are implicitly included in this separate profile. */
export const PREPARATION_RUNTIME_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ...FOUNDATION_RUNTIME_PRIVILEGES,
  ...([
    ["request_profiles", "namespace_id deployment_id chain_id contract_address genesis_hash runtime_code_hash authorizer deployment_block deployment_block_hash max_evidence_age_ms max_block_age_ms max_future_skew_ms", false, ""],
    ["requests", "namespace_id request_id code_hash deployment_id session_hash session_generation wallet handle requested_handle created_at expires_at attempt_id assessment_id owner_epoch preflight_observed_at preflight_valid_until preflight_block_number preflight_block_hash preflight_nonce", true, ""],
    ["publication_profiles", "namespace_id origin destination source", false, ""],
    ["public_artifacts", "namespace_id handle digest header svg png metadata", true, ""],
    ["publication_observations", "namespace_id digest object_kind phase identity observed_at", true, ""],
    ["completed_publications", "namespace_id digest completed_at", true, ""],
    ["issuance_profiles", "namespace_id deployment_id enabled lifetime_seconds signer_timeout_ms max_evidence_age_ms max_block_age_ms max_future_skew_ms", false, ""],
    ["authorizations", "namespace_id authorization_id deployment_id handle request_id session_hash session_generation recipient assessment_id artifact_digest nonce authorization_digest issued_at deadline payload state signing_epoch", true, "state signing_epoch"],
    ["authorization_heads", "namespace_id deployment_id handle authorization_id", true, ""],
    ["authorization_signatures", "namespace_id authorization_id signature recorded_at", true, ""],
  ] as const).map(([name, columns, insert, updates]) => Object.freeze({ name, columns: Object.freeze(columns.split(" ").sort()), insert,
    updates: Object.freeze(updates ? updates.split(" ") : []) })),
]);

/** One fenced runtime with preparation + projection. Only materialized mint and
 * ownership rows can be deleted for bounded unfinalized rollback. Immutable
 * logs, blocks, promotions, assessments and authorization evidence cannot. */
export const PROJECTION_RUNTIME_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ...PREPARATION_RUNTIME_PRIVILEGES,
  ...([
    ["projection_schema_version", "version", false, "", false],
    ["projection_deployments", "deployment_id namespace_id configuration", true, "", false],
    ["projection_checkpoints", "deployment_id head_number head_hash promoted_number promoted_hash health halt_reason", true,
      "head_number head_hash promoted_number promoted_hash health halt_reason", false],
    ["projection_blocks", "deployment_id number hash parent_hash canonical payload", true, "canonical", false],
    ["projection_logs", "deployment_id block_hash transaction_hash transaction_index log_index kind payload", true, "", false],
    ["projection_mints", "deployment_id token_id handle mbti nonce original_recipient block_number block_hash transaction_index log_index payload availability", true, "availability", true],
    ["projection_ownership", "deployment_id token_id owner start_block start_transaction start_log end_block end_transaction end_log mint_block mint_transaction mint_log", true,
      "end_block end_transaction end_log", true],
    ["projection_promotions", "deployment_id number hash policy_id evidence_reference", true, "", false],
  ] as const).map(([name, columns, insert, updates, deletion]) => Object.freeze({ name, columns: Object.freeze(columns.split(" ").sort()), insert,
    updates: Object.freeze(updates ? updates.split(" ") : []), delete: deletion })),
]);

/** Reviewed grant template for the foundation schema only. Returns SQL; never
 * creates a role, opens a connection, applies a migration, or grants ownership.
 * Request/publication/issuance/projection extensions need separately reviewed
 * grants before use. Run as a migration owner against an explicit database. */
export function foundationRuntimeGrants(role: string): string {
  return runtimeGrants(role, FOUNDATION_RUNTIME_PRIVILEGES);
}
/** SQL generation only; the operator applies it to an explicitly selected DB. */
export function preparationRuntimeGrants(role: string): string {
  return runtimeGrants(role, PREPARATION_RUNTIME_PRIVILEGES);
}
export function projectionRuntimeGrants(role: string): string {
  return runtimeGrants(role, PROJECTION_RUNTIME_PRIVILEGES);
}
/** Generative preparation + projection, without any finished-artifact store,
 * publication or output-authorization permissions. No operator policy writes. */
export const GENERATIVE_RUNTIME_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ...FOUNDATION_RUNTIME_PRIVILEGES,
  ...PREPARATION_RUNTIME_PRIVILEGES.filter(t => t.name === "requests" || t.name === "request_profiles"),
  ...PROJECTION_RUNTIME_PRIVILEGES.filter(t => t.name.startsWith("projection_")),
  ...([
    ["generative_input_profiles", "namespace_id deployment_id profile renderer_address renderer_code_hash renderer_identity", false, ""],
    ["generative_inputs", "namespace_id deployment_id handle digest payload", true, ""],
    ["generative_issuance_profiles", "namespace_id deployment_id enabled lifetime_seconds signer_timeout_ms max_evidence_age_ms max_block_age_ms max_future_skew_ms", false, ""],
    ["generative_authorizations", "namespace_id authorization_id deployment_id handle request_id session_hash session_generation recipient assessment_id input_digest nonce authorization_digest issued_at deadline payload state signing_epoch", true, "state signing_epoch"],
    ["generative_authorization_heads", "namespace_id deployment_id handle authorization_id", true, ""],
    ["generative_authorization_signatures", "namespace_id authorization_id signature recorded_at", true, ""],
  ] as const).map(([name, columns, insert, updates]) => Object.freeze({ name, columns: Object.freeze(columns.split(" ").sort()), insert,
    updates: Object.freeze(updates ? updates.split(" ") : []) })),
]);
export function generativeRuntimeGrants(role: string): string {
  return runtimeGrants(role, GENERATIVE_RUNTIME_PRIVILEGES);
}
/** Browser dispatch recovery adds only immutable plans, fences and observations. */
export const GENERATIVE_BROWSER_RUNTIME_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ...GENERATIVE_RUNTIME_PRIVILEGES,
  ...[
    ["wallet_mint_plans", "namespace_id deployment_id request_id authorization_id recipient wallet_nonce payload nonce_active"],
    ["wallet_mint_dispatches", "namespace_id request_id attempt permit_hash owner_epoch dispatched_at"],
    ["wallet_mint_reports", "namespace_id request_id attempt outcome transaction_hash recorded_at"],
  ].map(([name, columns]) => Object.freeze({ name, columns: Object.freeze(columns.split(" ").sort()), insert: true, updates: Object.freeze([]) })),
]);
export function generativeBrowserRuntimeGrants(role: string): string { return runtimeGrants(role, GENERATIVE_BROWSER_RUNTIME_PRIVILEGES); }
/** Distinct candidate capabilities; never added to historical RC1 grants. */
export const PULSE_TABLE_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ["pulse_profiles", "namespace_id deployment_id version candidate_lock_sha256 sale_config_hash payload", false, false],
  ["pulse_intents", "namespace_id deployment_id request_id mint_mode slot_id max_price payload", true, false],
  ["pulse_slot_heads", "namespace_id deployment_id slot_id request_id", true, true],
  ["pulse_sponsorships", "namespace_id deployment_id slot_id request_id attempt_id recorded_at", true, false],
  ["pulse_intent_releases", "namespace_id request_id reason recorded_at", true, false],
].map(([name, columns, insert, deletion]) => Object.freeze({ name: name as string,
  columns: Object.freeze((columns as string).split(" ").sort()), insert: insert as boolean,
  delete: deletion as boolean, updates: Object.freeze([]) })));
export const PULSE_BROWSER_PRIVILEGES = Object.freeze([...GENERATIVE_BROWSER_RUNTIME_PRIVILEGES, ...PULSE_TABLE_PRIVILEGES]);
export function pulseBrowserRuntimeGrants(role: string): string { return runtimeGrants(role, PULSE_BROWSER_PRIVILEGES); }
/** Offline operator only. No signer, provider dispatch, policy toggle, new
 * authorization, session mutation or historical-row deletion privileges. */
export const GENERATIVE_RECOVERY_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ...GENERATIVE_BROWSER_RUNTIME_PRIVILEGES.filter(t => ["schema_version", "writer_epoch", "namespaces", "session_profiles", "request_profiles",
    "assessment_attempts", "assessments", "generative_input_profiles", "generative_inputs", "generative_issuance_profiles",
    "generative_authorizations", "generative_authorization_heads", "generative_authorization_signatures",
    "wallet_mint_plans", "wallet_mint_dispatches", "wallet_mint_reports"].includes(t.name)).map(t => Object.freeze({ ...t, insert: false,
    updates: Object.freeze(t.name === "writer_epoch" ? ["epoch"] : t.name === "wallet_mint_plans" ? ["nonce_active"]
      : t.name === "generative_issuance_profiles" ? ["namespace_id"] : []),
    delete: t.name === "generative_authorization_heads" })),
  Object.freeze({ name: "generative_recoveries", columns: Object.freeze("namespace_id recovery_id deployment_id authorization_id request_id snapshot_hash finalized_number finalized_hash finalized_timestamp evidence owner_epoch recorded_at".split(" ").sort()), insert: true, updates: Object.freeze([]) }),
]);
export function generativeRecoveryGrants(role: string): string { return runtimeGrants(role, GENERATIVE_RECOVERY_PRIVILEGES); }
export const PULSE_RECOVERY_PRIVILEGES = Object.freeze([...GENERATIVE_RECOVERY_PRIVILEGES,
  ...GENERATIVE_BROWSER_RUNTIME_PRIVILEGES.filter(t => t.name === "requests")
    .map(t => Object.freeze({ ...t, insert: false, delete: false, updates: Object.freeze([]) })),
  ...PULSE_TABLE_PRIVILEGES.map(t => Object.freeze({ ...t, insert: t.name === "pulse_intent_releases", delete: t.name === "pulse_slot_heads" }))]);
export function pulseRecoveryGrants(role: string): string { return runtimeGrants(role, PULSE_RECOVERY_PRIVILEGES); }
/** Sepolia retirement principal, deliberately distinct from local recovery. */
export const STAGING_RECOVERY_PRIVILEGES: readonly RuntimeTablePrivileges[] = Object.freeze([
  ...GENERATIVE_BROWSER_RUNTIME_PRIVILEGES.filter(t => ["schema_version", "writer_epoch", "namespaces", "budget_policies",
    "request_profiles", "assessment_attempts", "assessments", "generative_input_profiles", "generative_inputs",
    "generative_issuance_profiles", "generative_authorizations", "generative_authorization_heads",
    "generative_authorization_signatures", "wallet_mint_plans", "wallet_mint_dispatches", "wallet_mint_reports",
    "projection_checkpoints"].includes(t.name)).map(t => Object.freeze({ ...t, insert: false,
      updates: Object.freeze(t.name === "writer_epoch" ? ["epoch"] : t.name === "wallet_mint_plans" ? ["nonce_active"]
        : ["budget_policies", "generative_issuance_profiles"].includes(t.name) ? ["namespace_id"] : []),
      delete: t.name === "generative_authorization_heads" })),
  Object.freeze({ name: "staging_generative_recoveries", columns: Object.freeze("namespace_id recovery_id deployment_id authorization_id request_id authorization_digest snapshot_hash approval_revision target_digest database_binding active_policy_digest operator_reference evidence_reference finalized_number finalized_hash finalized_timestamp latest_number latest_hash latest_timestamp source_ids observed_at valid_until evidence owner_epoch recorded_at".split(" ").sort()), insert: true, updates: Object.freeze([]) }),
]);
export function stagingRecoveryGrants(role: string): string { return runtimeGrants(role, STAGING_RECOVERY_PRIVILEGES); }
function runtimeGrants(role: string, profile: readonly RuntimeTablePrivileges[]): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || role.startsWith("pg_") || role === "public") throw new Error("Invalid dedicated runtime role.");
  const target = `"${role}"`;
  return [
    `GRANT USAGE ON SCHEMA open_mint TO ${target};`,
    `GRANT SELECT ON ${profile.map(table => `open_mint.${table.name}`).join(", ")} TO ${target};`,
    `GRANT INSERT ON ${profile.filter(table => table.insert).map(table => `open_mint.${table.name}`).join(", ")} TO ${target};`,
    // PostgreSQL SELECT FOR UPDATE requires UPDATE on at least one column.
    // Permit only an immutable key, never the operator's generation switch.
    ...profile.filter(table => table.updates.length).map(table => `GRANT UPDATE (${table.updates.join(", ")}) ON open_mint.${table.name} TO ${target};`),
    ...profile.filter(table => table.delete).map(table => `GRANT DELETE ON open_mint.${table.name} TO ${target};`),
  ].join("\n");
}
