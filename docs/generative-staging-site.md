# Private future-staging site and verified reveal

September 23, 2026. This is **local integration development**, not a deployed
Sepolia site or permission to activate one. No provider credentials, paid calls,
public transaction, hosting/TLS configuration or active rehearsal are involved.

## Composition

`contracts/tools/generative-staging-site.mjs` constructs the private runtime,
projection, chain-artwork reader, existing page templates and HTTP routes from
one validated release/operating/database binding. It captures the same two RPC
transports as the mint runtime. Collection, genesis, deployment, renderer,
domain, authorizer and namespace pins are not supplied by the browser.

The returned server is **unlistened and loopback-only**. `NODE_ENV=production`
is refused. The exact staging Host and one trusted loopback proxy's
`X-Forwarded-Proto: https` are required; other forwarding headers are refused.
This harness is not a deployable TLS or reverse-proxy entrypoint. It loads no
environment secrets, performs no migrations and never broadcasts a transaction.
The explicit staging session factory now uses the operating plan's host-only
`__Host-sg-staging`/`SameSite=Strict; Secure; HttpOnly; Path=/` policy. It does not
import the local `sg_open_session` cookie. The [transport checkpoint](generative-staging-transport.md)
records exact ingress/resource limits and the still-required hosted acceptance.

The [owned startup/lifecycle](generative-staging-lifecycle.md) now adds explicit
`start(port, signal)`, fresh observation before loopback listening, bounded
automatic cadence/backoff and coordinated admission shutdown. Only the owner
can call manual `sync(signal)` before owned startup. It is bounded by the existing observer
and database limits; overlapping passes are refused. HTTP reads cannot trigger
or accelerate synchronization. Certification/review checks surround each pass;
failed or cancelled checks withdraw read freshness. Closing withdraws reads
immediately, aborts work and drains the server/runtime/in-flight pass before
returning. The caller retains its writer; an incomplete drain must not be
treated as permission to release ownership.

The structural projection model now recognizes **Sepolia RC1**, but ordinary
Anvil constructors still reject that chain. Explicit staging factories select
the read-only reader, observer, coordinator and artwork adapter. Experimental
profiles and arbitrary chain overrides remain refused. Structural validation
alone cannot create the opaque, fresh observation witness.

## What users can see

| Evidence | Private progress / detail | Gallery |
| --- | --- | --- |
| Accepted assessment, signed plan or wallet-reported hash | Hidden artwork; ready or pending | Absent |
| Two-source canonical inclusion, matching successful receipt/logs and chain inputs | **Confirming**, verified artwork | Absent |
| Verified Ethereum `finalized` boundary | **Minted** | Home, MBTI and current-owner collections |
| Reorg, expired observation, source disagreement or lost writer/review | Withdrawn/unavailable; saved dispatch retained | No fresh result |

Status joins the authenticated request's handle to the verified projection,
not to a client-reported transaction hash. If another minter minted that handle,
the canonical token is shown; this is not a claim that the caller's transaction
succeeded. Request ownership is checked again after the projection read.

Artwork/media are recovered from the pinned on-chain renderer at the inclusion
block and matched to input, assessment, authorization and recipient commitments.
No private assessment or artifact journal substitutes for chain evidence. The
read is rechecked against current projection freshness before returning. Chain
recovery does not invent a Grok model, reasoning, sources or receipt history.

September 24 R2: detail pages can now enrich that verified artwork with the
exact saved accepted assessment, bound to its chain commitment and matching
handle/spelling/MBTI. The optional read is bounded and allowlisted; absent or
mismatched evidence leaves chain-only artwork usable with no inferred
attribution. Media/sharing bytes remain database-independent apart from the
existing projection verification. See [R2 provenance and evidence](r2-generative-provenance.md).

Existing pages are reused: `/`, `/<MBTI>/`, `/signatures/<handle>`, `/me`, `/about`,
`/p/<handle>/<MBTI>`, `/p/<handle>/variations`, `/mint` and private mint progress.
Handle casing/link policy, preview/mint distinctions, caveats, assets and free
preview behavior remain shared. Public browsing creates no paid assessment or
wallet dispatch. Only session-bearing mint/collection surfaces allocate sessions.
Pages and assets remain no-store/noindex. The baseline private API without site
composition continues to return only pending/unknown mint state.

The [staging sharing integration](generative-staging-sharing.md) now adds
canonical URLs and OG/X metadata to eligible public pages, without enabling
indexing. Confirming works still reveal on-page but have no social card;
finalized cards use a read-time PNG from the same pinned chain renderer.
Private mint/collection routes have no canonical or card metadata. Site close
also drains underlying artwork and sharing reads, including work that outlived
a response deadline; incomplete cleanup still retains writer ownership.

## Evidence and limits

The site integration suite uses disposable real PG16, mocked X/Grok adapters,
public test-key signing and **synthetic Sepolia RPC history**. Its receipt/log
and metadata inputs derive from the actual saved signed calldata. This tests
composition and trust boundaries; it is not an EVM mint, real Grok output or
independent public-RPC evidence.

Tests cover preparation through reveal/finality, guessed report hashes,
unfinalized rollback, finalized contradiction, source/receipt/code/metadata
failure, withdrawn review, cancellation, private progress/session boundaries,
inert browsing, restart without observation, and shutdown. The existing actual
disposable-Anvil RC1 rehearsal separately checks EVM minting, file-backed review,
writer restart, Confirming/finalized gallery and chain-only recovery.

Final local results: **44/44 runtime/site tests** (28 existing runtime + 16 new
site cases); **799 regression tests**, one intentional skip. Adapter coverage:
runtime 100% lines / 97.06% branches / 98.25% functions; HTTP 100/92.21/75;
site 100/91.14/82.35; combined 100/94.18/92.68. The existing runtime/HTTP-only
coverage ratchet is unchanged, and `npm run test:generative:staging-runtime` now
runs both suites sequentially. The final extra malformed-composition assertions
also pass in a focused rerun. No production source changed after that campaign.
The separate Anvil rehearsal passes 96 exact renderer comparisons and the
file-review/restart/EVM mint workflow. Build, typecheck, original renderer/slogan
locks and RC1 release lock pass; the candidate remains unapproved.

Logs are `staging-site-{combined-coverage,regression,anvil-regression,build,release,
runtime-extra}.log` under ignored `.local/generative-renderer/`. An initial test
fixture incorrectly changed a block's contents without changing its hash; the
projection correctly safety-halted. Corrected fixtures append a distinct mint
block. Failed intermediate runs are not counted as verification evidence.

Browser QA uses a temporary **GET-only local relay** to the synthetic site,
not a proposed staging proxy. Desktop dark-mode Confirming and mobile light-mode
mint-entry screenshots are inspected; DOM geometry and network results are
captured under ignored `.local/generative-renderer/staging-site-{dark,mobile}.*`.
The fixture SVG verifies image delivery/layout, not renderer parity. The browser
has no real extension wallet; the reconnect message is expected.

The subsequent [browser-wallet checkpoint](generative-staging-browser.md)
automates preparation, one send, restart/reload, lost outcomes, session/review
revocation, Confirming and finalized gallery. It fixes brief page-read BUSY
contention with a bounded, cancellable read-only wait and corrects pre-wallet
failure wording without changing retry guards. The expanded suite passes
46 runtime/site tests and 477 client/page regressions, plus three browser
scenarios. Detailed limits and final evidence are recorded there.

The exact staging cookie and trusted-loopback transport policy are now implemented;
hosted TLS/proxy isolation acceptance is still outstanding. The
[lifecycle checkpoint](generative-staging-lifecycle.md) records the new concurrent
observer/startup evidence and limits. Existing local EVM
and byte-parity evidence is reused, not relabelled as Sepolia acceptance. Real
X/Grok acceptance, operating custody/independent RPC evidence, hosting/TLS,
deployment and activation retain their separate approval gates. Finished-SVG
storage/compression and IPFS remain out of scope.
