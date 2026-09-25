# Local review files and startup preflight

September 22, 2026. Implemented for the **opt-in local RC1 runtime only**. Actual test runs use temporary signed fixtures, mocked paid HTTP, a disposable restricted-role PostgreSQL database and disposable Anvil. The running application is unchanged. This is not Sepolia approval, reviewer-key provisioning, independent security review, evidence collection or public database certification.

## Trust boundary

The operator supplies two independently pinned review configurations: assessment (`reuse`, `assessment-x`, `assessment-grok`) and mint (`reuse`, `sign`, `wallet-submit`). Each configuration includes:

- An explicit canonical absolute directory, simple `.json` filename and expected Unix owner UID.
- A trusted Ed25519 **public** key in SPKI PEM form and its independently expected SHA-256 over DER SPKI bytes.
- The exact admission scope, including the signed review revision, writer epoch, reviewed database binding, operating/chain-policy digests and deadlines.

Never read the expected key/fingerprint/revision from the signed envelope itself, derive them automatically from whichever file happens to be present, accept them over HTTP, or substitute `approved: true`. Fingerprints bind identity; they do not establish who approved the evidence. The surrounding bootstrap configuration and its review remain operator responsibilities. No operational keys or pins were invented for this checkpoint.

`openLocalReviewFile` imports no private key and never writes or signs a review. It constructs a current source for the existing `createLocalAdmissionReview` verifier. There is no environment-file search, global directory scan, network fetch, hot reload, approval CLI, secret resolver or automatic repinning.

## File format and constraints

The file is canonical JSON for the existing `{ "payload": "...", "signature": "..." }` envelope, optionally followed by one LF. `payload` is the canonical signed `local-admission-review-v1` JSON; `signature` is the 64-byte Ed25519 signature in lowercase hex. The existing verifier checks exact fields, signature, independent revision, scope, ordered allowed operations, evidence digest and validity interval. Duplicate/noncanonical envelope fields, invalid UTF-8 and extra approval-looking properties are refused. An evidence digest is a commitment to reviewed material, **not proof of its correctness**.

- Directory: canonical absolute path, expected UID, mode `0700`, no symlink alias. Its device/inode is pinned for the lifetime of the source.
- File: expected UID, mode `0400` or `0600`, regular file, exactly one hard link, nonempty, at most **32 KiB**. Signed payload remains capped at **16 KiB** by the verifier.
- Every checkpoint reopens the current pathname. It checks metadata before/open/after, uses `O_NOFOLLOW | O_NONBLOCK`, caps allocation/read size, supports partial reads and closes the descriptor. No cached file or watcher can preserve withdrawn authority.
- Missing files, unsafe permissions, root replacement, linked/nonregular files, changed bytes during a read, wrong keys/revisions, expired or malformed material stop that source permanently once observed. No file content, key material or path is included in the public error.

These checks assume a **trusted local filesystem and ancestry**. They do not certify ACLs, mount behavior, same-UID/root isolation or kernel integrity, and byte limits are not a hard deadline for a stalled filesystem syscall. Metadata checks are not an atomic filesystem/database/provider transaction. An attacker who controls the process or its independent trust configuration is outside this boundary. Do not use network mounts as an allegedly bounded approval service.

## Startup order

1. Keep the service unexposed. Acquire the existing exclusive database writer and open the already initialized local request/issuance profiles through trusted composition. This factory does not create the database, migrate, grant roles or take ownership. Writer acquisition already increments its durable epoch.
2. Obtain independently reviewed material for that exact writer epoch and database policy. A new writer needs a newly bound review; an old review cannot be relabelled to match it. Test fixtures regenerate keys/reviews for their disposable epochs; operational code does not.
3. Call `prepareLocalAdmissionStartup({ requests, expectedRole, assessment, mint }, signal)` with the two file configurations. It validates the shared operating/chain/writer/deadline scope and all required review operations, then audits the actual restricted writer, schema/grants and candidate assessment/mint database bindings. It rechecks current reviews after each asynchronous audit.
4. Construct the worker/runtime with the returned **same** `admission` instance. Call `await startup.recheck()` again immediately before starting the isolated listener. A successful check is not a serialized capability or public admission report.
5. Continue using the live checks at every real provider/signing/wallet-release boundary. Call `startup.halt()` to stop that composition; runtime drain also aborts its admission controller. Close resources owned by the caller normally, preserving durable uncertainty.

Preflight/recheck is read-only, cancellable and bounded by the configured scope timeout (at most 30 seconds) around asynchronous database work. A timeout cannot return a late runtime or close the caller's writer; in-flight database reads retain the writer's own statement limits. It cannot hard-interrupt a synchronous kernel filesystem call. Failures sanitize diagnostics, halt both sources and any constructed controller, and never start a listener or external effect. A successful startup does not enable generation/issuance switches or claim their disabled state authorizes effects. An expired paid-generation window does not make saved work eligible for another charge; operation admission still checks the relevant policy separately.

This is candidate **local** role/layout/profile verification, not exhaustive public migration/constraint/trigger provenance, remote database identity or custody certification. The public observer and existing production refusal remain unchanged.

## Withdrawal, replacement and rotation

- To withdraw, stop/drain admission or remove the appropriate review file. The source sees file changes at its next checkpoint, not through a background polling daemon. Explicit `startup.halt()` also cancels the shared controller immediately.
- Once a bad/missing/changed review is observed, restoring old bytes cannot revive that source. If one configured source fails during an operation or startup recheck, the shared controller is halted. Already released signatures/transactions cannot be recalled by this local control.
- Atomic file replacement with the **same** valid signed material is allowed. A different valid revision, even signed by the same key, is refused under the old pin. A different reviewer key is also refused. Key/revision changes require an explicit stopped/reconstructed composition with newly trusted pins and fresh preflight—never an automatic fallback or retry.
- The source does not maintain an external anti-rollback registry. On restart, the operator must supply the current trusted revision/key, not an older still-valid one. Transient withdrawal between checkpoints is not observable; revocation of authority already released requires the separate contract/operations controls.

## Verification and reproduction

- **50 file-source tests** include real permissions, symlinks, hard links, FIFO refusal, sparse oversize, malformed signatures/JSON, root replacement, independent key/revision rotation, short reads, and deterministic growth/truncation/replacement races against real descriptors. Measured coverage: **100% statements/functions/lines, 98.07% branches**, with a dedicated 100/98/100/100 threshold.
- **32 guarded-runtime PostgreSQL tests** include **18 new file-startup cases**: no-effect preflight, full worker/issuer/wallet integration, disabled switches, missing/crossed/insufficient reviews, role/database policy drift, withdrawal after X/before wallet release, cancellation, halt, and deadline while queued behind actual database work. New startup module: **100% measured statements/branches/functions/lines**.
- The actual file-backed Anvil rehearsal passes two startup epochs, exact saved signature reuse (one signer call total), local HTTP mint, canonical Confirming reveal, finalized-only gallery and database-free chain recovery. X/Grok calls are mocked; review signatures and wallet/signing accounts are disposable tests. No public transactions, live keys, paid calls or active-data changes occurred. No new real wallet-extension or visual-browser evidence is claimed in this increment.

```sh
npm run test:generative:review-files
# Set OPEN_MINT_TEST_POSTGRES_BIN to the PG16 binary directory if needed.
npm run test:generative:review-startup
npm run generative:rehearsal -- --execute-local-test-transactions --release-candidate --quick --mint --backend --review-files
```

Ignored logs/coverage: `.local/generative-renderer/review-file-focused.log`, `review-startup-focused.log`, `review-files-anvil.log`, `review-files-regression.log`, `review-files-release-admission.log`, `review-file-coverage/` and `review-startup-coverage/`. CI is configured, not yet observed remotely.

Follow-through, September 23: the separate [staging database certification checker](generative-database-certification.md) now pins exact ordered migration sources, structural catalog/ACLs and independently reviewed disabled staging profiles, with disposable mutation/refusal tests. It is not wired into this local startup or the running app and does not certify real migration history/remote identity/custody. **Next:** compose the separately gated Sepolia entrypoint and its resource limits. Do not treat local file reviews or a green test run as independent operating approval, live X/Grok billing evidence, permission to deploy, or permission to activate.
