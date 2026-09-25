# Future staging mint authority — local implementation

September 23, 2026. This is **local development with disposable PostgreSQL, synthetic Sepolia history, mocked assessments and public test signing keys**. It does not deploy, provision, fund, activate or broadcast anything. The active application, rehearsal environment and retained backups are unchanged.

## What this increment connects

`contracts/tools/generative-staging-mint.mjs` exports `createStagingMintController` beside the separate assessment worker. The controller consumes the same release/operating/database bindings and an independently pinned operation review. It keeps the input journal, issuer and wallet-submission resources private; there is no HTTP surface or automatic job loop.

- `preflightNonce` selects the exact existing authorization nonce, or a candidate for first issuance. The eventual runtime must obtain fresh request-specific backend chain eligibility for it. It neither reserves nor signs.
- `issue` validates wallet/session/consent, loads the database's accepted assessment, freezes compact generative inputs and reserves exact unsigned authority. The signing operation then passes the active-state observer and certified database gate, commits its signing fence, and only then invokes the server-installed signer. A saved signature is released through the private reuse gate without signing again.
- `stageWallet` verifies and releases the exact saved signature through the reuse gate, then saves one immutable transaction plan. Its network context is **trusted server input**, not browser-provided chain/nonce JSON. The next runtime/browser composition must supply it from bounded independent RPC reads; this port is not a replacement for that reader.
- `submit` releases a single wallet permit only after a fresh authorization/session/chain/review check and acknowledged durable dispatch fence. **The wallet sends the transaction, not this service.** An unknown or reported-submitted attempt cannot be sent again through this path. Explicit reported rejection permits only the existing bounded same-nonce, same-calldata resend policy.
- `report` and `submissionState` preserve private wallet progress. A client-reported hash is not proof of inclusion, reveal or finality. Reports remain recordable after issuance is disabled, with the original authenticated session, database and review requirements; no mint permission is granted by recording one.

Input handles, render casing, MBTI, assessment digest, renderer and signed authorization fields come from accepted records and pinned configuration. Caller-supplied overrides do not enter the signature. Wallet plans use the actual chain ID (`0xaa36a7` for Sepolia), not the historical Anvil literal.

## Kept closed

The existing input-journal opener, issuer opener, ordinary wallet constructor and local typed-data helper retain their local-only checks. Separate trusted internal staging factories require transaction guards and exact staging/Grok/RC1 bindings. Direct `issue` or `begin` is refused on those guarded resources; their operations must use the admission composition. These are boundaries for correct trusted server wiring, not protection from malicious code controlling the process.

`stagingGenerativeMintTypedData` is a distinct **pure encoder** for Ethereum Sepolia RC1 only. It performs no signing and is not an approval. Historical experimental domains, Anvil bytes, renderer sources and contract release locks are unchanged. Signature verification checks canonical ECDSA against the reserved domain and pinned authorizer; an Anvil-domain signature cannot substitute for a Sepolia one.

## Transaction boundaries and uncertainty

Shared configuration validation is factored out of the assessment controller without adding mint operations to that controller. The new SQL mint adapter certifies the exact migration/schema/grant/profile binding and cached request namespace inside the owning writer transaction. Generation is independent of saved mint work; current issuance is required for signing, saved authority release and wallet permits. Unsigned input preparation also checks the reviewed database before and after its insert.

Private loading/preparation requires `reuse` review. Signing and wallet dispatch additionally require their exact operation in the signed review. The actual release-aware observer is still used at each admitted authority-release boundary; neither a matching SQL profile nor request-specific eligibility alone substitutes for it.

Lost signing-fence or wallet-fence COMMIT acknowledgements preserve uncertainty and poison the writer; restart does not authorize replay. A signature committed before a lost response is recovered byte-for-byte. Invalid/late/cancelled signer results do not release authority, reset the nonce or permit another signing attempt. Cancellation drains the bounded signer outcome write before a new operation can reuse controller state. Review withdrawal after a committed fence can prevent the effect while leaving the fence preserved.

One explicit operation runs at a time. Halt is permanent for the controller; close also waits for its bounded in-flight cleanup. Hosting, admission, signer and SQL deadlines remain enforced. No timeout silently grants a longer paid or signing envelope. These mocked results do not establish actual custody, provider costs or real RPC independence.

## Verification and remaining integration

```sh
# Disposable PG16 tools on PATH, or OPEN_MINT_TEST_POSTGRES_BIN set explicitly.
npm run test:generative:staging-mint
```

CI runs the same isolated suite. Its new-controller/SQL-adapter coverage gate is 100% lines, 95% branches and 95% functions; existing assessment, database, local runtime and application thresholds are unchanged. The CI job ceiling is increased from 20 to 35 minutes for the expanded disposable-database campaigns, not to extend any application, admission, signer or transport deadline. Hosted CI has not been run for this checkpoint.

The integration suite uses the actual guarded assessment worker and accepted-record persistence, real PG16 transactions, real ECDSA with public test keys and the release-aware observer against fabricated chain history. It covers authority/casing integrity, restart/reuse, generation/issuance separation, review and permission withdrawal, lost acknowledgements, changed wallet plans, cancellation and refusal of duplicate authority.

September 23 local results:

- **34 mint integration tests passed.** New controller/SQL adapter combined coverage: **100% lines, 98.82% branches, 97.96% functions**. The SQL adapter itself is 100% in all three measures; the controller is 100/98/96.97. The deliberately rejecting read-only fence is not invoked by the controller's public methods.
- **68 assessment integration tests passed** after extracting shared configuration checks; their existing 100% line/function and 98% branch ratchet remains green (99.22% measured combined branches).
- **1,852 focused regression tests passed, seven intentional skips in 44 files**, including both local generative profiles, local runtime/HTTP, signing/nonce guards, staging review/certification and provider behavior. This is not a new full-application coverage run.
- Typecheck, build, original renderer/slogan locks, RC1 release lock and whitespace checks passed. The release still reports `candidate-not-approved`. No new browser, Anvil transaction, real-provider or hosted-CI evidence is claimed.

The cancellation tests exposed and verified a cleanup race: awaiting the gate's rejection alone could precede the durable `unknown` signer record. The controller now drains that bounded outcome work before returning/reusing state. Longer coverage tests also needed fresh synthetic block timestamps; application freshness deadlines were not loosened.

Ignored evidence under `.local/generative-renderer/`: `staging-mint-final-coverage.log`, `staging-mint-final-regression.log`, `staging-mint-assessment-regression.log`, `staging-mint-encoding-regression.log`, `staging-mint-build.log` and `staging-mint-release.log`.

Next: connect these ports to the bounded future-staging runtime and its fresh eligibility/wallet-network readers, private HTTP/session routes, projection and read-only site. Then rehearse the complete local mint → Confirming → finalized gallery flow before separately authorized operational acceptance. Public deployment, real paid X/Grok work, custody approval and activation remain separate gates. No finished-SVG storage/compression or IPFS work.

Follow-up: the [private staging runtime and loopback HTTP harness](generative-staging-runtime.md) now supply backend eligibility/nonce reads and guarded request creation. Site/projection composition and the complete offline mint/reveal rehearsal remain next; no public service was activated.
