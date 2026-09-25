# Public open-mint architecture proposal

**Superseding decision (September 21):** canonical artwork is generated at read time by immutable EVM code from immutable handle/MBTI inputs. Follow [Generative on-chain artwork](generative-onchain-artwork.md). All publisher, IPFS/HTTPS canonical artifact, finished-SVG storage and mint-time output-hash requirements below are historical proposals, not current implementation instructions. The private operational durability and security requirements still apply.

Status: **Ethereum Sepolia and `https://staging.signatures.gallery` approved as the staging target/origin on 2026-09-20; remaining operating decisions are under review. Local integration work may proceed.**

Recorded: 2026-09-20. Scope: E16 and the implementation boundaries for E17–E22 in [the development plan](development-plan.md). This document does not complete E16's review, authorize paid dispatch, select an account/vendor, provision infrastructure, deploy a contract, or authorize a public transaction. The current local startup refusal remains in force until its reviewed replacement exists.

September 23 implementation update: [paused Sepolia readiness](generative-staging-readiness.md) now has a separate read-only, resource-limited loopback entrypoint, cross-bound to signed review, exact database policy and fresh locked-deployment evidence. It provides health/readiness only, not the effect-capable application topology below. Public mint/runtime admission remains unimplemented; local-only guards and the active site are unchanged.

User decisions: “yes, use Ethereum Sepolia as staging target” and “agree with staging.signatures.gallery.” The exact intended origin is `https://staging.signatures.gallery`, on Ethereum Sepolia (`11155111`), not another chain's Sepolia deployment. These decisions do not provision DNS/TLS/hosting. RPC accounts, finality policy, infrastructure, key custody, deployment/funding and production authorization remain separate decisions. Do not infer an existing deployment or populate unknown chain/deployment hashes from this approval.

## 1. Proposed minimum topology

Run one long-lived application process with one exclusive writer, PostgreSQL for operational state, and bounded job and indexing loops inside that process. Store exact artwork and metadata bytes in immutable public storage, with a separate recoverable backup. The browser signs its own mint transaction. The backend prepares and signs a narrowly scoped authorization; it does not hold the user's wallet or broadcast mints.

```text
Browser ── HTTPS ── Application: HTTP + bounded jobs + bounded indexer
                         │                  │
                         │                  ├── Read-only chain RPC
                         │                  ├── Server-owned X / Grok transports
                         │                  ├── Restricted authorization signer
                         │                  └── Immutable artifact publisher/verifier
                         └── PostgreSQL: exclusive writer + durable records

Browser wallet ── user-approved transaction ── OpenSignatures
Public readers ── immutable URI / verified cache ── artifact bytes
```

No Redis, message broker, distributed worker, automatic multi-instance failover, or new renderer is needed for this increment. A host must support a persistent process and bounded draining on shutdown; a platform that silently overlaps replicas is unsuitable until it can enforce this model. PostgreSQL may be managed or self-hosted: that is an operating choice, not an adapter dependency.

Provisional capacity assumptions for local implementation are one active paid attempt, one rendering/publication job at a time, one indexing batch at a time, at most 100 queued jobs, and gallery pages of at most 50 entries. All limits must be explicit, validated configuration with hard maxima. These limits are conservative starting points, not a measured public capacity promise or permission to increase today's pilot limits. Revisit them using fixture load tests before a public rehearsal.

The design favors safety over availability: losing database ownership, receipt durability, publication integrity, chain confidence, or signer identity stops affected mutations. Previously validated read models and exact artifacts may remain readable with their recorded confidence; absence of a trustworthy chain observation never becomes `unminted`.

## 2. Current facts and boundaries

| Current implementation | Consequence for public work |
| --- | --- |
| `src/main.ts` enters `src/openMint/main.ts`; the entrypoint requires literal loopback and refuses `NODE_ENV=production`. | Add a separately reviewed public startup path/profile. Do not relax the local restrictions as a hosting shortcut. |
| `storage.ts` provides atomic per-key files and an exclusive process lock; `SerialKeys` and service job maps only coordinate one process. | Keep the file adapter for local work. PostgreSQL needs domain transactions, not a JSON key/value table pretending cross-record writes are atomic. |
| `assessment.ts` freezes the first accepted assessment and validates its digest; `assessmentOperations.ts` separately records attempts, receipts, exposure, and uncertainty. | Preserve these immutable values and failure semantics. Database normalization must not change commitment inputs. |
| `security.ts` keeps session, challenge, generation, and wallet proof in memory; restart deliberately invalidates them. | Add a durable session implementation with atomic challenge consumption and generation checks. |
| `service.ts` constructs unversioned local metadata with absolute local URLs, embeds the full assessment, and hashes an artifact record including `tokenURI`. | Copying bytes to a public host does not produce a valid public migration. Use a new metadata/artifact profile for new public records. |
| `network.ts` is a loopback/31337 adapter, reads `ownerOf`, verifies provenance and supports EOA recipients without code. | Public chain support is a new adapter; transfer support needs a durable projection rather than a new identity model. |
| `OpenSignatures.sol` uses `SignaturesOpenMint` / `1`, one lowercase literal handle per contract, immutable commitments, a trusted authorizer, pause and nonce revocation. | Preserve that contract model. The legacy GalleryOfSignatures deployment script, manifest and indexer are incompatible as delivered. |

The canonical identity is the lowercase ASCII handle (`[a-z0-9_]{1,15}`), not an X user ID, recipient, MBTI, or renderer version. The preparation-time verified X username and ID remain an immutable snapshot, not proof that the minter owns the X account. A renamed/reassigned X handle does not change this contract identity.

## 3. Environment and ownership contract

Introduce an explicit runtime profile, conceptually `local-fixture | local-real | staging-testnet | production`. This is a proposed interface, not an existing environment variable. `NODE_ENV` controls ordinary runtime behavior only; setting it to `development` must never admit public hosting. Unknown or incomplete profiles fail startup.

| Profile | Admission and isolation |
| --- | --- |
| Local fixture | Literal loopback, isolated files/Anvil, explicit simulated provenance; existing developer controls only here. |
| Local real | Literal loopback, separate real namespace, existing reviewed paid envelope and local user-approved mint. Never loads fixture exemptions. |
| Staging testnet | Ethereum Sepolia, with an exact approved HTTPS origin and pinned chain identity; separate database, artifacts, secrets and deployment manifest; real public security checks; no fixture provider, fixture galleries, study routes, dev wallet, dev mint, Anvil control, or test key. Always noindex. |
| Production | Separately disabled until E24 launch approval and reviewed startup checks. Staging authorization cannot enable it. |

Public startup must validate the database schema/profile/namespace, writer ownership, deployment manifest, chain ID and genesis/deployment block hashes, runtime code hash, EIP-712 name/version/address, trusted signer and role configuration, URI profile, publication readiness, clock skew, bounded budgets, finality policy and index freshness. A required check that is unavailable is a blocker. Read-only degraded operation can be explicitly configured; generation and signing must each remain fail-closed.

Use exact configured origins and a documented trusted-proxy list. Do not trust arbitrary `Host`, forwarded host, or forwarded IP headers to select origin, chain, issuer, redirects or rate-limit identity. Public cookies require Secure, HttpOnly, SameSite and the fixed host/path policy; private request/session responses remain no-store and noindex. Do not create sessions on anonymous immutable-asset reads. The support origin is a user decision and must not acquire private mint codes through query strings or diagnostics.

Key responsibilities are separate:

- The deployer signs deployment only; it need not retain a privileged role. Delayed admin, authorizer manager, pauser and nonce revoker have named human/account owners and an explicit role-separation decision before deployment.
- The online signer signs only the exact OpenSignatures typed-data domain and backend-constructed commitments. It has no admin, pause, funding, transfer or deployment authority. A signer adapter may target a managed signer, HSM, or an explicitly approved secret-backed key; no custody choice is made here.
- X/xAI credentials and publisher credentials have separate secret references and minimum necessary permissions. Nothing supplies them through a public request, database artifact payload, browser bundle, manifest, URL or log. Public staging rejects known development keys and local test signer wiring; this check is not a substitute for approved custody.
- Pausing new assessment generation is different from pausing on-chain minting. Signer rotation invalidates outstanding authorizations from the previous signer in the current contract; nonce revocation is a separate, approved chain operation. A timeout does not prove either operation succeeded.

E13 remains the supported-wallet decision. The current EOA-without-code restriction is the implementation baseline; this proposal does not approve mobile support, smart accounts, relayers or delegated-code wallets.

## 4. PostgreSQL model and transactions

Use a new `open_mint` schema and explicit `namespace_id` on operational records. A namespace binds environment, assessment policy and provenance mode; its identity is server-owned and immutable. Staging and production use separate namespaces/databases. A deployment additionally binds chain ID, contract address, code and manifest. Changing contract or host must not silently create a new assessment namespace or a chance to reroll an accepted result.

Store immutable assessment/artifact payloads as exact UTF-8 `bytea` plus validated scalar columns and commitment hashes. JSONB is suitable for bounded operational payloads and public projections, but not as the source of historical `JSON.stringify` bytes or a serialization-based digest. Deserialize and validate immutable records on ingestion and trusted read boundaries. Historical optional fields retain absence rather than being filled from present-day information.

The following names are proposed tables, not existing migrations. UUIDs identify private operational objects; chain quantities use checked `numeric(78,0)` or canonical integer strings at TypeScript boundaries, never JavaScript floating-point conversion. Hashes and addresses use fixed-length bytes or strictly checked canonical hex. Money uses nonnegative integer USD ticks at scale 10, matching current receipts.

| Table / key | Required contents and invariants |
| --- | --- |
| `namespaces(namespace_id)` | Profile, provenance mode, schema/policy versions, immutable origin/URI profile references where relevant. No client-selectable namespace. |
| `deployments(deployment_id)` | Namespace, chain/contract identity, verified manifest hash, code hash, deployment block/hash, finality profile, enablement state. Unique chain+contract. |
| `handle_guards(namespace_id, handle)` | Permanent canonical-handle row; initial attempt and accepted assessment references. Serializes same-handle decisions even before an assessment exists. |
| `assessments(namespace_id, handle)` | Unique ID and digest, exact payload bytes, renderer/policy/provenance, MBTI and frozen identity fields. Insert-only canonical result; conflict returns an identical validated result or fails integrity checks. |
| `assessment_attempts(attempt_id)` | Namespace/handle, record version, immutable admission/profile/accounting mode, monotonic phase markers, safe outcome, accepted-assessment reference, reconciliation and artifact state; optional original attempt/recovery action reference. One initial attempt per handle; linked recovery is disabled until E21. |
| `provider_receipts(attempt_id, leg)` | Versioned exact allowlisted receipt, timing, HTTP category, bounded provider IDs, usage validity, actual/estimated/unknown cost. Insert-only; same value is idempotent and conflicting value is refused. Audit later billing evidence separately. |
| `budget_policies(namespace_id, policy_id)` and `budget_reservations(attempt_id)` | Versioned reviewed limits, immutable admitted UTC day/profile/reserved ticks, linked evidence of actual/unresolved exposure. Preserve total and unresolved exposure across days; never delete reservations to reset allowance. |
| `sessions(session_id_hash)` | Token hash, expiry, generation, wallet, code-scoped or general proof, proof expiry and revoked state; CSRF verification material. Unique opaque token supplied only as a cookie. |
| `wallet_challenges(challenge_id_hash)` | Session FK, exact signed message bytes, generation, wallet, request scope, expiry, consumed time. One active challenge per session; consumption cannot race. |
| `requests(request_id)` | Unique opaque code hash, session FK, wallet, handle and original spelling, created/expiry times, status, attempt/assessment links and sanitized error. Code is a capability, not a diagnostic identifier. |
| `jobs(job_id)` | Kind, namespace, unique deduplication key, referenced IDs, state, owner epoch, attempts, eligibility time, bounded failure code. Payload contains references, not secrets or provider bodies. |
| `artifact_blobs(namespace_id, sha256, media_type)` | Exact bytes or recoverable immutable backup locator, byte length, public URI/CID, serializer/importer version. Digest and byte length must agree; immutable once recorded. |
| `artifacts(namespace_id, handle)` | One frozen artifact binding per handle in this namespace: assessment FK/digest, render handle, image/metadata hashes, format/digest version, tokenURI and artifact digest. Publication progress is separate and cannot rewrite it. |
| `publications(publication_id)` and `publication_receipts(publication_id, step, destination)` | Deduplicated artifact target, state, exact object/hash/CID expectation, upload/pin receipt, independent retrieval evidence, verified time and sanitized failure. `verified` requires every required object and configured durability check. |
| `authorizations(authorization_id)` | Deployment, handle, request/session/recipient, exact typed-data bytes and digest, nonce, issue/deadline times, artifact/assessment commitments, signer identity, signature and lifecycle. Unique deployment+nonce and typed-data digest; payload immutable. |
| `authorization_heads(deployment_id, handle)` | FK to the current reservation, updated under handle lock. Avoid a time-dependent partial unique index; expiration and replacement require explicit trusted-chain reconciliation. |
| `transaction_hints(request_id, transaction_hash)` | Browser report and observation time, bounded cardinality; untrusted until matching canonical chain evidence. Hints do not establish ownership or mint success. |
| `chain_blocks`, `chain_logs`, `chain_checkpoints` | Deployment, block/parent hashes and positions, canonical/finality status, decoded allowlisted log and validation; unique block-hash/transaction/log position. Checkpoint advances with projection in one transaction. |
| `mint_projections`, `ownership_intervals` | Verified immutable mint position/recipient/commitments plus current and historical owner observations at indexed block boundaries. Unique deployment+handle and deployment+token; separate original recipient from current owner. |
| `operator_actions(action_id)` | Append-only operation, actor, exact idempotency input digest, original/new attempt, evidence and approval references, result. No raw credentials or capability codes. |

Foreign keys must include namespace/deployment scope so a record cannot link to another environment. Bound opaque codes, receipt fields, metadata, source arrays and job payload size at both parsing and persistence boundaries. App roles cannot update/delete accepted assessment or frozen artifact fields; privileged migrations are separate from runtime access. Operational state transitions use compare-and-set/version checks, not arbitrary JSON replacement.

### Exclusive writer and failure ownership

Acquire a PostgreSQL session advisory lock in a dedicated open-mint lock namespace before admitting HTTP mutations or starting jobs. Keep the ownership connection pinned, not returned to a pool. Serialize mutations through transactions on that connection initially; separate bounded pooled connections may serve reads. The second process fails startup rather than waiting and becoming a surprise writer.

Acquire a monotonic writer epoch in the same startup transaction and attach it to job claims and mutation checks. On ownership-connection error/end or ambiguous commit, immediately stop admission/signing/dispatch, mark the process unhealthy and require recovery before resuming. Never silently reconnect a lost owner and continue old work. Use the same behavior on graceful draining: stop new work, drain bounded work, preserve uncertain records, then release ownership.

A database lock cannot cancel an already-started external call or guarantee exactly-once delivery across network failure. The durable pre-dispatch marker is the paid-work fence: a replacement process must treat a marked leg as possibly dispatched, even if its prior process is gone. Rechecking the writer epoch prevents stale database writes; it does not prove that a remote call did not occur.

### Required transaction boundaries

1. **Request and admission:** obtain a bounded trusted chain preflight before the transaction. In the transaction, verify live session generation/wallet proof and preflight freshness, lock budget-policy then handle-guard rows in a fixed order, and check canonical result, attempts, request limits and count/exposure/kill-switch policy. Atomically insert/reuse the request and, only for approved new work, its attempt, reservation and one deduplicated assessment job. No provider, RPC or signer call runs inside this transaction. A duplicate request joins durable work or reuses the accepted result; it does not create a second paid job. Recheck safety immediately before egress; no off-chain preflight can prevent a competing chain transaction after the observation.
2. **Provider leg:** commit `xDispatchedAt` or `grokDispatchedAt` before the corresponding call. On return, persist the allowlisted receipt before semantic acceptance; persist validated identity before Grok dispatch. Commit canonical accepted assessment, accepted linkage and next render job atomically when validated bytes are available. If bytes never became durable, restart cannot rerun Grok. Receipt/outcome/accepted states are distinct: a billing receipt does not reconstruct an assessment.
3. **Challenge verification:** consume the matching unexpired challenge with a generation compare-and-set before asynchronous signature verification. After verification, lock the session and require unchanged generation, nonrevoked session and unexpired exact challenge context before saving proof. A failed/consumed challenge requires a fresh challenge; it is never restored for replay. Logout/replacement increments generation and invalidates proof durably.
4. **Authority:** verify request ownership, wallet generation, fresh chain eligibility, exact stored commitments and verified publication. Under the handle reservation lock, commit the precise nonce/recipient/deadline/domain/artifact reservation before signing. Sign only that persisted payload, validate the returned signature locally, persist it, then return a transaction. A missing signing response can only reconcile or sign the identical payload; it cannot allocate another nonce/recipient. Loss of the final persistence acknowledgment must not return authority.
5. **Replacement:** elapsed request time or authorization deadline alone does not establish that a reported/unknown transaction failed. Reconcile canonical mint, nonce usage/revocation and any unresolved submission first. Once the prior authority is conclusively unusable and the handle remains unminted, a new explicitly requested authorization may reuse the same assessment/artifact. Never change an accepted result to recover a wallet error.
6. **Projection:** atomically save validated logs, affected mint/owner rows and scanned/promoted block hashes. A failed commit replays only deterministic chain observations. Transaction hashes supplied by users never skip canonical verification.

No automatic paid retry is added by the job table. A safely queued attempt with no dispatch marker may execute its original, still-authorized job after recovery checks; any marked provider leg from an interrupted execution stops for review. A verified X result without a Grok marker is still not a general permission to resume spending after restart: conservatively block the interrupted paid pipeline until its recovery policy is explicitly reviewed. Pure rendering, hash verification, identical-byte publication and bounded chain reads can have capped retries because they do not request another assessment or change authority. Publisher retries need content-addressed idempotency and must obey the approved storage cost policy.

## 5. Adapter interfaces for local implementation

Introduce domain repositories under `src/openMint/` without replacing the active file adapter until parity is established. The shape below is a boundary specification; referenced domain input/result types must be explicit, bounded and versioned in implementation.

```ts
interface OpenMintPersistence {
  acquireWriter(namespace: NamespaceId): Promise<WriterOwnership>;
  transaction<T>(owner: WriterOwnership, work: (tx: OpenMintTransactionStore) => Promise<T>): Promise<T>;
  assessments: CanonicalAssessmentReader;
  requests: SessionBoundRequestReader;
  operations: PrivateAttemptReader;
  gallery: BoundedGalleryReader;
}

interface OpenMintTransactionStore {
  admission: AssessmentAdmissionRepository;
  assessmentResults: InsertOnlyAssessmentRepository;
  providerReceipts: InsertOnlyReceiptRepository;
  sessions: SessionAndChallengeRepository;
  requests: SignatureRequestRepository;
  jobs: BoundedJobRepository;
  artifacts: FrozenArtifactRepository;
  publications: PublicationRepository;
  authorizations: AuthorizationReservationRepository;
  chain: ChainProjectionRepository;
  audit: AppendOnlyOperatorAudit;
}

interface ImmutableArtifactPublisher {
  // Computes a profile-qualified URI without network access or upload.
  prepare(bytes: Uint8Array, mediaType: ArtifactMediaType): Promise<PreparedObject>;
  // Writes only the exact expected content; conflicting bytes are an error.
  publish(object: PreparedObject, bytes: Uint8Array): Promise<PublicationReceipt>;
  // Retrieves independently of the upload response and verifies all bytes.
  verify(object: PreparedObject): Promise<RetrievalEvidence>;
}

interface AuthorizationSigner {
  readonly expectedAddress: Address;
  signReserved(input: PersistedOpenMintAuthorization): Promise<Hex>;
}
```

Repository methods must name their transaction prerequisites: admission locks global policy/handle; receipt insertion requires a committed dispatch marker; result acceptance requires matching attempt/handle/profile; reservation requires exact artifact/publication/session versions. A generic `put` API must not bypass those constraints. Implement a memory transaction adapter for deterministic fault tests and a PostgreSQL adapter for real transaction/concurrency tests; the former cannot prove PostgreSQL isolation or durability.

Separate `OpenMintChainReader`, transaction construction, and `AuthorizationSigner` when adapting today's `OpenMintNetwork`. The public chain reader has no broadcast, wallet-management, mining or RPC URL override capability. Generation transports remain server-owned and reuse the existing `AssessmentExecution` hooks. Repositories and read services must remain constructible with no provider or signer credential so saved-result recovery does not depend on new generation being enabled.

The durable session adapter will be asynchronous: adapt server call sites and tests deliberately rather than pretending the synchronous `WalletSessions` map persists. Store only opaque token/code hashes for lookup; no log or public projection may contain the raw cookie, CSRF material, challenge message containing a private capability, or request code. Existing live-cookie recovery supplies the original token. If the UI needs a reusable request link from a hash-only lookup, issue a new session-bound request for the same saved result or use a separately reviewed protected capability store; do not reverse or expose hashes as new capabilities.

## 6. Immutable public URI and artifact profile — superseded proposal

**September 21 decision:** canonical artwork must be fully on-chain. The [selected on-chain architecture](fully-onchain-artwork.md) supersedes this section's IPFS/HTTPS proposal and its publication prerequisites for new public deployments. The text below documents the historical implementation only; do not provision pinning/storage or issue new public external-URI mints from it. The new contract/domain, embedded SVG metadata, chain recovery and integration order are specified in the selected architecture. Existing immutable contracts/records remain unchanged.

**Proposed default, awaiting URI/storage review:** content-addressed `ipfs://<canonical CIDv1>` token metadata, PNG and SVG, using the existing deterministic UnixFS importer profile as the starting point. Compute CIDs locally before publication. Pin/retrieve adapters are vendor-independent. Maintain two independently recoverable copies, with at least one serving the public URI and a verification path independent of the upload response. The concrete replication/pinning operators and retention budget require approval; an upload acknowledgment alone is insufficient.

A content-addressed HTTPS object service is a possible approved alternative, but its exact immutable origin/path and durability policy become a different URI profile before any public artifact is frozen. Never select a fallback hostname at runtime after a publication error. Gateway URLs may change in the UI cache layer without changing an IPFS tokenURI; exact metadata bytes, URIs and on-chain hashes cannot change.

Define these new public-only versions and pin golden vectors before E18 integration:

- Metadata document: proposed `sg-open-mint-metadata-1.0.0`, canonical JSON UTF-8 with a pinned canonical serializer and no platform-dependent bytes. It contains the artwork description/caveat, exact verified spelling, MBTI, frozen assessment date/model/provenance/source projection, assessment digest, renderer version, SHA-256 image hashes, immutable image/SVG URIs, and approved HTTPS artwork permalink. The public projection excludes provider request/response IDs, receipts, charges, operational attempt IDs, sessions and mint capabilities. It must not imply the public subset can independently reconstruct the complete private assessment digest.
- Artifact commitment: proposed `signatures.gallery/open-artifact/v2`. Define the exact ABI-encoded tuple as `(string domain, bytes32 assessmentDigest, string canonicalHandle, string renderHandle, string rendererVersion, string metadataVersion, bytes32 svgSha256, bytes32 pngSha256, bytes32 metadataSha256, bytes32 tokenURIHash)`, then take Keccak-256. SHA-256 fields are exactly 32 decoded bytes; `tokenURIHash` uses the existing `openMintTokenURIHash`. The stored versioned record includes all inputs. This is a new digest function; never run it over an old artifact and overwrite its original digest.
- Assessment digests remain their existing v1/v2/v3 algorithms and exact accepted inputs. Database schema version, receipt version, metadata version, artifact digest version, renderer version, URI importer profile and contract ABI/domain version are independent. A receipt/schema upgrade does not upgrade artwork or assessment commitments.

The metadata includes the assessment digest and image hashes, but not the artifact digest or its own URI/hash; those would create a circular construction. The sequence is: persist accepted assessment → render/freeze SVG and PNG → derive image URIs → build/freeze exact metadata with those URIs → derive metadata URI and artifact commitment → publish all exact bytes → independently retrieve and check all bytes/CIDs/hashes → mark publication verified → allow reservation/signing. A failure can retry the same bytes only. A change of approved policy produces a new namespace/version before new work, not mutation of an existing binding.

Public immutable storage is readable before mint; reveal remains a UI experience, not a secrecy guarantee. The user selected early reveal with **Confirming** after backend-verified canonical inclusion; terminal gallery/ownership promotion remains separate. See the [reveal policy](mint-reveal-policy.md) for the implemented local flow and remaining Sepolia coordinator work. Do not include an unincluded result in ordinary progress responses or provisional artwork in minted sharing tags. Existing local metadata includes its historical full assessment and provider response ID; preserve its historical bytes. That fact is not a reason to include provider references in the new public profile.

Fresh public artifacts in a fresh approved namespace are the default. There is no automatic `.local` import, path scan, hostname rewrite, IPFS relabel, legacy claim conversion, or re-assessment. An explicit later import must back up the source, inventory exact hashes and existing authorizations/mints, classify provenance, dry-run into a separate namespace, and obtain the assessment/artifact reuse decision. Reusing old image bytes may be possible; creating new public metadata and a new artifact commitment is still a new binding and cannot rewrite the old work.

## 7. Chain projection and bounded galleries

E19 needs a distinct OpenSignatures deploy script, ABI/version identifier, manifest schema and validator. Record constructor arguments and role owners, compiler/build/source hashes, chain identity, deployment transaction/receipt/block, runtime code hash, `SignaturesOpenMint` / `1`, trusted authorizer and exact immutable collectionURI. The current contract does not expose the legacy collection SHA getters or authorizer epochs; do not invent them in validation. Collection metadata must be published and verified before the deployment package is eligible for approval. A local dry-run can use mocks/Anvil; public broadcast remains a separate action.

Persist `OpenSignatureMinted`, `Transfer`, signer/nonce/pause/role observations and contiguous block headers from the exact deployment block. Use bounded block ranges, log counts, response sizes and per-tick work; provider errors shrink/pause work rather than starting unbounded backfill. Retain block-hash-qualified observations so shallow reorgs can roll projections back to a common ancestor and replay. A contradiction at a previously promoted finality boundary halts promotion and new authority for that deployment until reviewed.

The finality profile must be explicit for Ethereum Sepolia: promotion rule, independent RPC agreement requirement, maximum lag, historical-state requirement, rollback horizon and what happens when finality tags are absent. The selected early-reveal policy does not substitute a confirmation count for Ethereum finality or choose operating constants. Local two-confirmation behavior is not a public finality policy. Separate submitted/pending, verified-inclusion/Confirming, finalized/publicly promotable, unknown/unavailable and safety-halted states. Apply the same terminal confidence boundary to gallery mint and current owner, while revealing provisional artwork only through the separate verified-inclusion boundary. Verify mint provenance against durable authorization and artifact commitments; a matching event name alone is insufficient.

Home/MBTI/owner queries use database indexes and stable descending mint position `(block_number, transaction_index, log_index, token_id)`, not last access, assessment time or mutable owner-change time. Cursor payloads bind deployment, filter, limit policy, snapshot block/hash and final item position; validate all fields and bound retention. Pin subsequent pages to the same promoted snapshot, using retained ownership intervals for owner filtering, or explicitly invalidate an expired/reorged snapshot and ask the client to restart. Do not silently mix current-owner pages from different snapshots. One quarantined corrupt artifact or transient fetch failure must not invalidate unrelated gallery entries; expose an honest availability state and diagnose privately.

## 8. Reuse candidates and specific exclusions

| Candidate | Reuse | Do not carry over unchanged |
| --- | --- | --- |
| `src/openMint/assessment.ts`, `assessmentOperations.ts`, `providerReceipt.ts` | Validators, accepted-result semantics, bounded receipts, lifecycle ordering, failure fixtures. | In-memory coordination and sequential file writes are not database transactions; no paid retry worker. |
| `src/openMint/authorization.ts`, `network.ts` | Current typed-data helpers, signature verification, code/signer/provenance checks and read-only transport design. | Private-key-in-network configuration, loopback/31337 assumptions and local confirmation policy. |
| `src/local/postgresState.ts` | Dedicated writer ownership, fail-closed connection loss, checkpoint/projection atomicity lessons and tests. | Legacy in-memory snapshot serialization, local lock namespace and claim-specific store shape. One big JSON snapshot cannot provide bounded public queries. |
| `src/store/postgresStore.ts` | Parameterized queries, transaction rollback, conflict/integrity checks, stable keyset pagination patterns. | X OAuth account/claim identity, claim withdrawal behavior, `local_rehearsal` ledger and unrestricted pool writer paths. |
| `src/v2/core/ipfsCid.ts` and generic canonicalization from `metadata.ts` | Deterministic importer/CID parsing and byte-level test techniques. | Legacy metadata fields, claim wording, gr0k seed model, signature IDs and metadata version. A CID computation is not proof of pin durability. |
| `src/v2/publication/control.ts` | Exact-version/fencing checks, staged/verified/activated transition and stale-completion tests. | Claim erasure, suppression and legacy deployment control graph; immutable public token assets cannot promise deletion. Implement a small open-mint publication state machine. |
| `src/v2/indexer/*`, `src/local/chainReconciler.ts` | Block/hash checkpoints, event positions, canonicality, rollback/halt and transfer test scenarios. | GalleryOfSignatures topics, wallet-binding/authorizer-epoch identity and authorization evidence schema. Rebuild the decoder/projection for OpenSignatures. |
| `src/v2/operations/startupHealth.ts`, deployment script/manifest validator | Explicit blocker results, independent observations, build identity and fail-closed rehearsal gates. | Legacy domain/version, collection getters, role names/epoch checks, fixed network and pin-provider choices. |

These are adaptation candidates, not a request to reactivate the legacy entrypoint or migrate its users.

## 9. Recovery, verification and approval boundary

Back up database and exact artifact bytes with a tested restore procedure; storage location, encryption custody, retention, acceptable data loss and recovery time are operating decisions. A restore is not permission to restart jobs immediately: it may have lost the newest dispatch markers or signed authorizations. Keep generation/signing disabled until database history, signer audit, provider/billing evidence and canonical chain state cover the recovery gap. If that cannot be proven, retain uncertainty and block affected work. Preserve original records through migration and rollback; rolling application code back may require read-only mode if it cannot understand the current schema.

Safe local increments, in order:

1. Define the new profile/config validator and versioned public artifact golden vectors with mocked publisher/chain/signer. Keep public profiles disabled in the active entrypoint.
2. Add additive open-mint schema migrations and transaction repositories against a disposable local PostgreSQL database. Test duplicate admission, one initial attempt, conflicting receipt/result insert, budget rollover, second-writer refusal and connection-loss/ambiguous-commit behavior.
3. Add durable sessions and bounded job transitions. Test logout/challenge replacement during verification/signing, session continuity after restart, dispatch-marker crashes and result-only recovery. Paid transports stay mocked.
4. Add versioned immutable publication and authorization reservation. Inject faults at each upload/verification/commit/signature-return boundary; retries preserve exact bytes, URI, nonce and commitments. Test that unverified publication cannot issue authority.
5. Add OpenSignatures-specific manifest/deploy preparation, public-adapter mocks, projection and cursor tests. Exercise wrong chain/code/domain/signer, transfers, shallow reorg rollback, deep contradiction halt and index lag without contacting a public chain.
6. Integrate the reviewed staging profile only after its decisions are recorded; complete E21 backup/restore, rate limits, request deadlines, proxy policy and operator recovery review before E23. E24 remains independent launch authorization.

The following are actual user/operating decisions, not inferred approvals:

| Decision | Needed before | Local work that can continue |
| --- | --- | --- |
| Hosting/operator, PostgreSQL account/location, spending/retention and recovery targets | Provisioning and public operation | Schema, repository interfaces, disposable local tests and backup format |
| Ethereum Sepolia selected; RPC accounts, finality/confidence policy and funds still needed | Public deployment/rehearsal | Sepolia-targeted configuration design, manifest schema, chain mocks and reorg tests |
| App staging origin selected: https://staging.signatures.gallery; artifact URI profile, pin/storage accounts, replication and long-term ownership remain | Freezing public metadata or uploading it | Serializer/CID adapters, exact-byte fixtures and dry-run publication |
| Signer custody; deployer/admin/manager/pauser/revoker owners and role separation | Key setup, signing in a public environment or deployment | Restricted signer interface, signature tests and role manifest validation |
| Wallet/device support, support/escalation destination and claim wording | Public acceptance/content completion | Existing EOA flow and E13/E14/E12 work within its current scope |
| Any local-assessment/image reuse or historical import | Import or new binding from local data | Read-only migration design; no source data is touched |
| Reviewed provider budget/recovery authorization and E23/E24 go/no-go | Further paid dispatch, public rehearsal, or launch respectively | Mocked tests and operator dry-run contracts |

E16 becomes reviewed only when its proposed boundaries and outstanding decisions have been accepted and recorded. An implementation of local adapters is evidence of preparation, not evidence of approved public deployment.
