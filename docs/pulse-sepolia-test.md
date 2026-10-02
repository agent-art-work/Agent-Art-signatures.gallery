# Disposable Pulse Sepolia test

September 27, 2026. The user approved using the existing Sepolia deployment
wallet, two free slots for that wallet, a seven-day free window, nominal test-ETH
Pulse settings and a separate mint-authorizer key. This is **not** production
economics, a real Grok assessment campaign or acceptance of the paused R5 package.

The site-only public read projection and its optional PostgreSQL setup are
documented in [pulse-site-relay.md](pulse-site-relay.md). It is not a mint
authority and does not change this disposable deployment's economics.

## Deployment

| Component | Sepolia address |
| --- | --- |
| Released Pulse Core v1.0.0 (reused) | `0xfb1Cc26356b1b0361c414Ec1B5fB52c5FEDc3EAC` |
| Immutable signature renderer | `0x954b4Ee81F46a04435792A6deeA5126F058b13C1` |
| Signatures Pulse collection | `0x88c435146A017338E48Abe3BEE2F11BcEab79cC2` |
| Test operator / treasury / recipient | `0x3e4fA9f09d8EDe66561145E1ef3bc127F80ED396` |
| Separate, unfunded mint authorizer | `0xFE61593Ef7196845f2400596c6AD7f8138622970` |

Renderer deployment: `0xcbbdfb60fc0b0570bac8e33e1209060f2590703415e087c4a733f144bd1d91ff`.
Collection deployment: `0xfbe832baa6824c0715989f5300845bd572582e1c64406f92b81c52c12ebf081f`.

The existing C5/C8 frozen contract is used without Solidity changes. The
collection constructor binds chain ID 11155111, the released Core's runtime
hash, renderer identity, allowlist root, deadline, treasury and pricing. Exact
creation inputs and deployed runtime bytes/immutables were compared against
two RPC endpoints. The separate public source verification below also passed.
Neither check constitutes an independent audit or proof of RPC operator independence.

## Public source verification

The user explicitly approved public source transparency on September 27. Both
contracts were published with Foundry's Sourcify verifier and received
**`exact_match` for both creation and runtime bytecode**:

| Contract | Public sources | Verified at (UTC) | Sourcify match ID |
| --- | --- | --- | --- |
| Collection | [SignaturesPulseMintV1RC1](https://repo.sourcify.dev/11155111/0x88c435146A017338E48Abe3BEE2F11BcEab79cC2) | 2026-09-27 02:58:19 | `53250178` |
| Renderer | [SignatureRendererV1RC1](https://repo.sourcify.dev/11155111/0x954b4Ee81F46a04435792A6deeA5126F058b13C1) | 2026-09-27 02:57:39 | `53250106` |

Before publication, the source inventory was restricted to the Solidity
contracts, pinned Pulse interface and OpenZeppelin dependencies, and checked
against the compiler's source hashes. After publication, all 35 collection and
7 renderer source entries were read back from Sourcify's v2 API and compared
byte-for-byte with the local files; their metadata matched the original
`rawMetadata` compiler output. Foundry's parsed `metadata` projection is not a
lossless reference: it omits NatSpec and normalizes remapping context prefixes.

Compiler: `0.8.30+commit.73712a01`, Prague, optimizer enabled with 200 runs.
No secret/environment files were uploaded, no signing key was used, no contract
was modified and no gas was spent for publication. This establishes public
Sourcify verification; it does not claim Etherscan verification or production
approval. The frozen candidate lock is unchanged.

Machine-readable [verification evidence](validation/pulse-sepolia-sourcify-2026-09-27.json)
includes public API and job links. Use the v2 API for read-back; the legacy
`repository/contracts/full_match/.../metadata.json` URLs returned 404 for these
new v2 records despite successful verification.

The two duplicate-wallet slots have distinct slot IDs 0 and 1. The deadline is
2026-10-04 02:35:24 UTC. Exhausting both slots closes free minting earlier.
Pulse parameters (integer wei units where applicable):

```json
{"k":"600000000000","genesisPrice":"1000000000000","genesisFloor":"900000000000","pts":"1000000000"}
```

The paid test ceiling is 0.0001 Sepolia ETH; actual pricing follows Pulse and
unused value is refunded. Gas is additional. Administrative roles and treasury
share the operator only for this disposable test, not as production custody.

## Commands and durable state

```sh
npm run test:pulse:sepolia
npm run pulse:sepolia -- verify
npm run pulse:sepolia:dev
```

The test website binds **127.0.0.1:3004 only** and refuses `NODE_ENV=production`.
It listens for pages immediately; finalized deployment verification runs in a
read-only recovery lane before any mint authorization is available. The existing
port-3003 preview server, `.env.local`, active `.local/rehearsal`, database and
historical backups are not changed. The original public-startup guards remain
intact; this explicit test composition does not satisfy their release gates.

If public RPCs prevent full backend verification, `npm run pulse:sepolia:fe`
starts a separate **read-only** Sepolia frontend on that port. It uses the same
page components, Pulse layout, assets and local preview renderer. It does not
call RPCs, load signing keys or sessions, read/write mint records, or start the
mint backend. Every API returns 503, wallet proof and minting remain disabled,
and `/health` explicitly reports `frontendOnly: true, observerHealthy: false`.
Previously verified public artwork can be served from the presentation cache;
it never enables minting. Unavailable galleries carry a warning, never invented minted entries or a
claim that the gallery is empty on-chain. Stop this frontend before starting
the complete verified backend with `pulse:sepolia:dev`; this mode never promotes
itself to a minting service automatically.

September 28 read-only FE verification: 34 Sepolia tests and typecheck passed.
Served `/mint` passed 14/14 browser checks across desktop light and mobile dark,
with both screenshots inspected: Ethereum Sepolia, Pulse options, no Anvil
label, visible unavailable state, disabled wallet/mint controls and no horizontal
overflow. Page, font, stylesheet, script and favicon requests returned 200;
the session API deliberately returned 503. This verifies the frontend only,
not a healthy observer, wallet integration, Grok assessment or successful mint.

Startup compares canonical creation receipts/transactions and exact current
runtime/authority state at a recent pinned block from a validated source. Initial configuration and
paused state come from the creation receipt plus exact constructor bytes.
The primary comes from the private Sepolia environment; the read-only secondary
is explicitly pinned to `https://sepolia.gateway.tenderly.co`, not the
SDK's mutable default. On September 28 the installed SDK default pointed to
Thirdweb and repeatedly timed out on contract reads; an OnFinality probe also
failed intermittently during full authority checks. The pinned secondary was
checked against the configured PublicNode primary at a shared canonical block
before use. Startup rejects duplicate RPC hostnames, including a different path
or URL spelling on the same host. Different hosts do not certify operator
independence. The historical September 28 run used two-source agreement;
the September 29 runtime policy below replaces that admission requirement
with validated primary/fallback reads. The explicit CLI verification command
still audits both sources.
For a dev run where the configured primary is timing out, a process-only
`SEPOLIA_READ_RPC_URL` override selects a different HTTPS primary without
editing the private environment or key references. It retains the distinct-host,
chain identity, canonical block, runtime, constructor and authority checks.
For example, OnFinality and the pinned Tenderly secondary can be used together:

```sh
SEPOLIA_READ_RPC_URL=https://eth-sepolia.api.onfinality.io/public npm run pulse:sepolia:dev
```

Artwork checks immutable inputs and SVGs at a recent pinned block from the
selected validated source. An archive-state RPC is **not** required. One bounded retry is
allowed for a classified transient read; broadcasts and EVM reverts are never
retried by that wrapper. Initial chain certification can take several minutes
on public RPCs, but pages are available as soon as the origin is printed. Mint
preparation requires fresh independent contract checks, not gallery synchronization.
Integrity conflicts still block effects. See the September 29 recovery design below.

September 28 backend startup correction: PublicNode and Tenderly returned the
same deployment receipt, but Tenderly included an additional `blobGasUsed: 0`
field. Whole-object equality incorrectly treated that provider annotation as a
chain disagreement. Deployment verification now compares the required canonical
EIP-1559 receipt fields, including status, block/transaction identity, sender,
recipient, created address, gas accounting, bloom and all log contents/indexes.
Addresses and hexadecimal quantities are normalized without changing the raw
evidence. Optional log annotations do not establish identity; malformed/missing
required fields, a nonzero blob-gas claim on this non-blob deployment, or any
critical disagreement still refuse startup. Observer log comparisons use the
same normalization. Regression tests cover both the false rejection and
altered receipts/logs; the frozen contract and authority checks are unchanged.

The full backend subsequently passed live two-source deployment and initial
observation checks and replaced the read-only process on port 3004. A subsequent
periodic observer refresh advanced the snapshot and remained healthy. All 36
Sepolia regression tests and typecheck passed. Desktop light and mobile dark
passed 18/18 served-page checks, with screenshots inspected: session HTTP 200,
enabled wallet connection, healthy observer, no unavailable notice, correct
network/paid-phase text, and no horizontal overflow. A temporary unfunded key
generated only in memory completed real SIWE challenge/signature/verification
and fetched a paid quote; missing proof, wrong CSRF, proof replay and access
after logout were refused. This check neither unlocked the funded deployer nor
prepared, began or broadcast a mint; no X/Grok requests were made. The two free
slots remain exhausted. Public RPC availability is still required during use;
the observer's stale/disagreement guards remain enabled.

User-facing copy now says "Mint availability cannot be checked right now. Please
try again shortly." rather than "Sepolia observation". Checking availability
does not prepare a mint request, so this notice does not imply that one exists.
The regression suite verifies the unchanged 90-second cutoff,
missing/failed reads, plain-language response and unmodified saved state.
All 37 Sepolia tests and typecheck passed. After restart, the full backend
reported healthy; the served page passed 12/12 desktop-light/mobile-dark browser
checks with an isolated mock wallet and simulated availability failure. Both
screenshots were inspected. This visual check did not access the user's wallet
or submit a mint, and does not claim to fix the underlying RPC availability.

September 28 repeated-warning diagnosis: connecting verifies the wallet before
automatically requesting mint options. A missing snapshot, a failed observer
refresh or a snapshot older than 90 seconds refuses those options; it does not
undo the wallet proof. The observer rereads the bounded deployment history on
each pass, then waits 15 seconds. One read-only probe took 37 seconds and 27 RPC
calls. Thirteen live health samples remained healthy, with snapshot ages up to
77 seconds, and an isolated unfunded SIWE sign-in and options check both returned
200. The reported failure on every connection was therefore not reproduced in
that run. An earlier options error in the wallet feedback also remains after a
successful manual "Check mint options" click; that feedback-clearing issue is
not fixed by this copy change. No mint was prepared or submitted. A regression
test covers repeated options failures without losing the verified wallet or
automatically preparing/sending a mint; all 38 Sepolia tests passed.
After a graceful site-only restart, `/health` returned 200 with a healthy
observer. The served mint page passed 12/12 isolated-browser checks across
desktop light and mobile dark, with both screenshots inspected. These checks
simulated the availability failure, not the user's installed wallet or a live
RPC failure; no mint was prepared or submitted. Typecheck also passed.

Ignored private state is in `.local/pulse-sepolia-v1/` (directory 0700, files
0600):

- `plan.json`: deterministic frozen deployment inputs and predicted addresses.
- `journal.json`: signed transaction bytes saved and fsynced **before** broadcast,
  plus hash, nonce and receipts. Do not discard it to retry an uncertain send.
- `authorizer.key`: test authorizer secret. Never copy it into Git, browser code,
  screenshots or chat. It has no operator/treasury role and holds no funds.
- `deployment.json`: latest byte/constructor/role verification and finality.
- `smoke.json`: actual test mint receipts and on-chain artwork checks.
- `web-records.json`: fixed fixture inputs, prepared browser plans and durable
  submission-start state. Browser session proofs intentionally expire on restart.

Wallet access in Rabby is not the site's signed session proof. The connect
button reports opening, Sepolia account checks, sign-in approval and verification
directly underneath it. It remains disabled during connection; challenge and
verification HTTP calls have a 45-second timeout with no automatic retry.
Account/network changes invalidate an in-progress proof, and EIP-6963 Rabby
metadata is preferred over a competing legacy injected extension. The existing
RC1 code-bearing-wallet restriction is unchanged, including EIP-7702 delegation.

September 28 navigation restoration: a valid signed server session now silently
reattaches the browser wallet using only `eth_accounts` and `eth_chainId`.
The selected account must match the server-proved address and the chain must
remain Sepolia. No authorization popup, chain switch, new SIWE challenge,
signature, preparation or transaction is initiated on page load. Delayed
EIP-6963 discovery is supported, and BFCache browser-back restoration refreshes
the server proof as well. Account/network/disconnect events, a mismatched or
unavailable wallet, and a bounded permission-read timeout cannot enable minting.
An existing pending submission is only observed, never replayed. A slow quote
does not delay wallet reattachment or override a later account-change state.
The HttpOnly cookie's 24-hour lifetime, the signed proof's 10-minute lifetime,
restart expiry, backend wallet-code checks and transaction guards are unchanged;
no client-side "connected" flag is treated as authentication.

Restoration verification: all 49 Sepolia tests and typecheck passed. The actual
served mint -> preview -> browser-back route passed 24/24 desktop-light and
mobile-dark checks, with both screenshots inspected and no failed HTTP
responses. Wallet/session responses in those isolated browsers were mocked;
the route also covered valid/expired BFCache proof restoration, preserved
handle input, button styling, no overflow, no wallet prompts, no API writes
and no automatically selected mint mode. Separately, a freshly generated
unfunded key used only in memory completed real server SIWE and retained the
same proved wallet across preview/mint GETs (5/5 checks). The temporary session
was logged out afterward. No funded key, installed user wallet, X/Grok request,
mint preparation or chain transaction was used. The restarted site remained
healthy on port 3004. A user must reconnect once after that process restart;
subsequent ordinary navigation reuses the valid signed session.

Connection feedback verification (September 27): all 29 Sepolia tests and
typecheck passed. Headless Chrome checked the served page with a mocked wallet
in light and dark modes: 18/18 progress, placement, duplicate-click and no-send
checks passed, with the error about 10px below the connect button. A separate
actual backend request for the public Anvil address returned HTTP 409 and
`DELEGATED_WALLET_UNSUPPORTED` in 2.6 seconds, without issuing a challenge or
requesting a signature. This does not certify the installed Rabby extension's
interaction; it verifies the served UI and the real backend rejection separately.

Deployment signing reads the existing private `~/.opsec/path/env/sepolia.env`
keystore/password references, validates the expected public address, and unlocks
only in memory. Neither private keys nor RPC credentials are logged or passed
in process arguments. The website loads only the isolated test-authorizer key;
it cannot sign a deployment, unpause or send an on-chain transaction itself.

For an interrupted CLI deployment/test, inspect the journal and receipt first.
The same explicit command can resume **the identical signed bytes**:

```sh
npm run pulse:sepolia -- deploy --broadcast
npm run pulse:sepolia -- smoke --broadcast
```

These commands are chain writes, not routine startup. They refuse changed
nonces, inputs, contract artifacts, chain identity, fee policy or a replaced
journal transaction. Do not delete state, choose a new nonce or regenerate an
authorization to escape an uncertain outcome. A PID lock must be checked for a
live owner before any stale-lock removal. A reverted or expired mint requires
operator inspection; there is no automatic replacement or assessment retry.

## Website scope

The site reuses page components and supports `/mint`, `/p/<handle>/<MBTI>`,
`/p/<handle>/variations`, `/signatures/<handle>`, MBTI galleries and `/me`.
All preparation uses deterministic **fixture MBTI, not Grok**. User-facing copy
is source-neutral, and collapsed provenance identifies the sample input and
states that Grok was not called. The network label remains Ethereum Sepolia.
Developer notices belong in these docs and operator output, not the home
guidance, mint explanation, wallet feedback or a repeated page banner. The real
Grok page composition retains its existing Grok wording; the sample composition
does not imply real X research. There are zero X/xAI calls or charges. User-submitted
MBTI is rejected at the mint API. This does not validate real Grok research.

Mint options show the observed global phase before wallet connection, including
`Free mint ended · 2/2 slots used.` for exhaustion and an explicit deadline
reason when appropriate. Wallet-specific eligibility and the current paid quote
still require sign-in; showing the phase does not authorize or select a mint.
September 27 copy/status regression: 18 Sepolia tests, 179 page/provenance tests,
and typecheck pass. Frozen mint rules, keys, reservations and balances are unchanged.
Live visual DOM/CDP checks pass on desktop light (1024×1250) and mobile dark
(390×1250): the phase/reason is visible without connecting, no horizontal
overflow, and all page/asset requests succeed. Eight routes were audited
(`/`, `/mint`, `/about`, `/me`, preview, variations, MBTI gallery and minted
detail): no developer notices or false Grok attribution in the main content;
the minted detail retains truthful sample-source disclosure inside closed
provenance. Screenshots were inspected. No wallet signing or transaction was
needed for this presentation change.

Minting requires a real Sepolia wallet proof, same-origin/CSRF protection,
explicit mode and price ceiling, and a saved submission-start marker before the
wallet prompt. The site's signing limit is 50 prepared fixture handles and
0.0001 test ETH per paid authorization. Connecting never prepares or sends.
The wallet chooses its own public-chain nonce. Never use an Anvil public key.

The `/mint` handle field keeps a bounded, tab-local `sessionStorage` draft in
both the normal client and this Sepolia client. Reloads preserve spelling,
leading `@`, partial input and deliberate clearing. A different URL-prefilled
handle supersedes the draft; edits to a prefilled handle survive same-URL
reloads. The preview link follows the restored field. Storage failures are
non-blocking, and the draft never restores wallet proof, a price/mode selection,
assessment submission or mint consent.
Validation: 279 client/draft/Sepolia tests and typecheck pass. A live headless
browser completed eight assertions across real reloads and URL changes on
port 3004; only page/assets/session GETs occurred, with no sign-in or mint POSTs.

### Wallet connection fixes (September 27)

The disposable client now changes the wallet button's **child label**, preserving
the shared `.auth-action > span` border and padding. Regression mocks model the
real DOM's destructive `textContent` behavior so Connect/Reconnect/Change and
busy updates cannot silently remove the styled span again.

The deployed RC1 contract still requires a caller with no on-chain code.
EIP-7702 delegation (`0xef0100` plus a 20-byte address) is recognized separately
from ordinary contract bytecode, but remains unsupported by this deployment.
The server checks wallet code at a pinned block from its selected validated source before
issuing a sign-in challenge, before new/reused preparation, and before recording
submission-start. An account change or chain mutation can therefore not bypass
the on-chain restriction through a previously prepared request. This is a
support boundary, not an anti-bot guarantee. Delegation can still change after
any read; the contract remains the final execution-time check.

Only typed public errors cross HTTP. Assertion diffs (including custom-message
assertions), RPC details and internal values are replaced with generic feedback.
The UI asks the user to choose an undelegated account instead of calling every
code-bearing account a conventional smart-contract wallet.

The existing funded operator address was confirmed from the encrypted keystore
as `0x3e4fA9f09d8EDe66561145E1ef3bc127F80ED396`. At block `0xb3efb5`, both
RPCs returned code `0x` and balance `0.28629568282719021` Sepolia ETH. The key
was not printed or sent to the browser. No transaction or contract change was
performed for these fixes. Extending the frozen wallet support policy requires
a separately reviewed replacement deployment; it is not enabled by this patch.

Regression: 24 Sepolia tests, 189 page/provenance/CSS tests, typecheck and the
unchanged candidate lock pass. Isolated DOM/CDP browser checks of the actual
mint markup, shared CSS and Sepolia client pass on desktop light (1024×1250)
and mobile dark (390×1250): one preserved label span, 1px border, matching
3px/7px padding and 26.89px height with the neighboring secondary button,
no overflow, all requested assets/session responses successful. Both screenshots
were inspected. This isolated visual check does not certify an installed-wallet
mint or replace the live startup verification.

Restart verification also found a growing-history bug: the secondary public RPC
rejects `eth_getLogs` ranges larger than **1,000 blocks** with error `-32005`.
The previous 2,000-block pagination only worked while the deployment was young.
Queries now cover at most 1,000 blocks inclusive, with no gaps/overlap; the two
sources must still agree on every page. A 2,049-block regression exercises three
pages per source, and observer failure never publishes a partial snapshot.
The extracted read-only observer recovered all three existing mints and the paid
phase against both sources at block `0xb3f028`, without unlocking a signer,
changing any mint record, or requiring the full deployment check for diagnosis.
After the fix, full verified startup succeeded on port 3004. Live DOM/CDP checks
also passed on `/mint` (preserved border/label span, no overflow, all requests
200). The actual HTTP challenge endpoint returned a clean
`409 DELEGATED_WALLET_UNSUPPORTED` for the reported public Anvil account and
accepted the funded operator account with 200. These checks stopped at the
sign-in challenge: no wallet signature, mint preparation or transaction was sent.

The observer compares both sources' canonical mint logs and input digests.
Verified inclusion reveals a **Confirming** detail; only finalized entries enter
the gallery in the original September 27 behavior (superseded below). An RPC
failure fails closed rather than claiming unminted status.
Artwork is read from the deployed renderer through the collection, not IPFS.
Reported browser transaction hashes alone never establish inclusion.

### Immediate verified-inclusion reveal — September 28

The Sepolia mint page now reveals the actual signature inline as soon as a
successful inclusion has been validated. It stays on `/mint`, labels the work
**Confirming**, and updates to **Minted** on finalization. Home, MBTI and wallet
galleries include the same verified Confirming work immediately; finalization
is no longer a presentation gate. No assessment output or artwork is exposed
merely because a wallet returned a hash.

For a reported transaction, a targeted read checks both RPC receipts, the
canonical inclusion block, successful status, exact collection/recipient,
mint and zero-address Transfer events, renderer input commitment, immutable
inputs, matching SVG and pinned authorizer. This avoids waiting for the
full collection-history scan. The full observer still supersedes these bounded
receipt observations and withdraws noncanonical inclusion after a reorg.

In the original immediate-reveal implementation (finalized-status handling is
superseded by the correction below), previously revealed images stayed visible during a
temporary RPC failure or recheck, with **Status unavailable** or **Rechecking
mint**, not a false Minted badge. A verified reverted receipt shows a failed
transaction message without revealing new artwork or resubmitting. Reload
restoration saves only a handle reference and must acquire fresh RPC-validated
reveal evidence again. Wallet signing, spending consent and the durable
submission fence are unchanged.

The durable projection's presentation queries explicitly opt into fresh
RPC-witnessed inclusion, with per-work `mintState` and canonical snapshot
pagination. Default finalized-only evidence queries and ownership/sharing
authority are unchanged. Inclusion-mode cursors cannot be reused as finalized
cursors, and database checkpoints alone cannot authorize an early reveal.

Verification: 880 automated tests pass (627 shared UI/service/page, 188 real
disposable-PostgreSQL projection/HTTP, 65 Sepolia Node), plus typecheck and
whitespace checks. Eight isolated Chrome scenarios pass 64 assertions across
desktop light and mobile dark, including in-place inclusion/finality, retained
images on RPC failure/recheck, all three Confirming gallery surfaces, and
historical gallery presentation with an explicit `Status unavailable` label.
Screenshots were inspected. These scenarios mock status/session responses and
accelerate only the read polling interval; they do not send a real wallet mint.
The targeted receipt path also validated the already-existing `anagentartist`
INFP mint against both sources and returned its actual 1,422-byte on-chain SVG.
Full details: `validation/pulse-sepolia-immediate-reveal-2026-09-28.json`.

The updated port-3004 runtime passed another 28 read-only Chrome checks using
the actual deployed `AnAgentARTist × INFP` artwork: inline `/mint` on desktop
light/mobile dark, all four home-gallery images, and the INFP gallery on mobile
light. Screenshots were inspected; no failed asset requests or horizontal
overflow. The isolated browser seeded only the saved handle reference, not a
wallet proof or mint result. Every API response and SVG came from the live site;
no new wallet signature, mint or paid provider request was made. Together these
browser checks total 92 passed, zero failed. This is not a new installed-wallet
mint certification.

In that original implementation, a fresh, independently validated receipt could reveal even when the full-history
observer is unavailable. The last verified in-process gallery snapshot and its
cached, immutable SVGs can remain visible as `Status unavailable`; this is not
fresh status, ownership, mint admission or sharing evidence. A successful newer
canonical snapshot supersedes receipt hints, including withdrawal after a real
reorg. The status API, mint preparation and sale checks do not use historical
presentation evidence. A first reveal still requires fresh validation.

Local startup used a process-only primary read override,
`SEPOLIA_READ_RPC_URL=https://ethereum-sepolia.publicnode.com`, with the unchanged
Tenderly secondary. No private environment, authority or deployment was changed.

### Incremental observer and stable finalized status — September 28

An ordinary RPC outage or a stale refresh no longer changes a previously
finalized work to **Status unavailable**. Home, MBTI, collection, detail and
inline mint results retain **Minted**, with one separate, lightweight notice:
**Warning:** Live network checks are temporarily unavailable. Previously
verified mints are shown. The title uses the existing amber warning style;
the content retains normal ink. The notice is in the page content, not over
the top navigation, and is not repeated on every tile.

This distinguishes a finalized mint fact from network availability. Unfinalized
inclusions still expire as fresh evidence, remain monitored, and can be
withdrawn by a new canonical scan. Already revealed images can remain visible
with an honest unavailable/rechecking label. A verified finalized checkpoint
conflict also invalidates the old Minted label, refuses receipt/status fallback
and blocks minting. That conflict is sticky through later transport errors;
only a successful anchored observer pass clears it.

The collection observer bootstraps once from deployment history. Later passes
reuse only the private, process-local finalized prefix and rescan the complete
unfinalized suffix, in at most 1,000-block pages per source. Both RPC
sources recheck the old finalized anchor, current agreed heads and pinned
authorizer. Latest and finalized anchors are checked again after log reads;
regressed finality, foreign/forged checkpoints, duplicate identities, out-of-range
logs and source disagreements cannot publish partial snapshots. A restart
requires full deployment verification and a new bootstrap; no database cursor
or saved browser flag substitutes for RPC evidence.

Previously validated finalized evidence can answer presentation/status reads
during an outage. It is not fresh sale, mint-admission or ownership authority.
Unknown handles are not inferred unminted from a stale partial map. Collection
ownership fallback is explicitly described as the last verified collection.
Preparation still requires a healthy snapshot no older than 90 seconds,
wallet/chain proof, explicit spending consent and the durable begin fence.
There is no automatic mint resend, new deployment, paid provider request or
deployer unlock in this work.

Regression verification: **706 automated tests** (628 shared UI/service/page
tests and 78 Sepolia Node tests), typecheck and whitespace checks pass.
**111 isolated browser assertions** pass across ten desktop/mobile, light/dark
scenarios, with screenshots inspected. Browser verification moved the warning
into page content after finding a mobile navigation overlap; the shared amber
title/normal-content style is retained. These scenarios use mocked read-only
status/session responses and do not certify a new installed-wallet mint. The
historical PostgreSQL acceptance run above was not rerun for this change.
See the separate [observer validation record](validation/pulse-sepolia-observer-2026-09-28.json)
for the scope and current live-startup evidence.

The health endpoint includes safe scan bounds, last-refresh duration and numeric
HTTP failure diagnostics, making incremental progress and provider rate limits
measurable without exposing RPC credentials or signed data. Reads are bounded to
two in flight per source and spaced by one second, including retry attempts.
HTTP 429 responses wait three seconds before the one permitted safe-read retry;
broadcasts are never retried. Startup assertions and canonical-block rechecks
are unchanged. Public RPC latency/availability remain intermittent, not a
reliability certification.

Historical live run, September 28 (superseded by the September 29 policy below):
the full port-3004 backend could not be restarted
through its strict gates. PublicNode returned no known deployment receipt,
OnFinality returned HTTP 429, BlockReq's free endpoint refused genesis history,
and 1RPC passed isolated probes but later returned intermittent RPC errors and
timed out on a block read. dRPC returned HTTP 400 on the final bounded recheck.
No startup assertion was bypassed. A dedicated Sepolia RPC URL has been
requested from the operator; private environment settings were not edited.

Port 3004 has been restored using the existing **read-only frontend**, with no
signing keys, wallet sessions, RPC calls or enabled mint APIs. Its warning now
uses the same content-area mount instead of being inserted over navigation;
unavailable galleries no longer claim there are zero minted signatures. **21
live read-only frontend browser assertions** pass across desktop light and
mobile dark, with screenshots inspected, no overflow and no failed assets.
The session API deliberately returns 503. This is not a live mint/gallery
acceptance run: the previous four real works are not fabricated into this
read-only frontend, and their status has not been freshly re-certified here.

This is a bounded contract/wallet rehearsal, not a hosted multi-user service:
sessions are local, fixture reservations need manual recovery after unknown
submission, RPC operators are not independently certified, and the production
PostgreSQL/real-provider/backup-release admission path is not activated.

### Validated primary/fallback runtime — September 29

The user approved replacing mandatory two-of-two RPC agreement for this
disposable website with **`validated-primary-fallback/v1`**. One validated,
available endpoint is sufficient for runtime reads. This changes the RPC trust
model, not Ethereum consensus or the frozen contract. It does not claim a quorum
or provider independence, and does not activate the paused production release.
The explicit `pulse:sepolia -- verify` deployment/audit path still checks both
sources; it is no longer a prerequisite for this website to listen.

Before use, a source must pass chain ID, Sepolia genesis and published Core
runtime checks. Startup still verifies the exact collection/renderer runtime and
immutables, canonical finalized creation receipt, constructor transaction inputs,
admin, delay, roles and mint authorizer. Subsequent source validation also binds
the collection and renderer bytecode to those verified hashes at a recent pinned
block. Validation is shared across concurrent reads, expires after 60 seconds,
and is invalidated when the deployment binding becomes available.

The controller prefers the primary. A classified transport failure, unsupported
read method, missing required data or stale current/finalized head can retry the complete
read at the separately validated fallback. An unavailable source cools down for
30 seconds, after which primary recovery is automatic. Each semantic operation
(deployment verification, history scan, receipt reveal, wallet check or artwork)
uses one source throughout; failover discards partial results rather than mixing
pages, receipts or SVG evidence. The existing per-endpoint two-call concurrency,
one-second request spacing and one bounded transient-read retry remain in place.
There is no automatic transaction retry, signature, broadcast or paid API call.

Wrong chain, changed runtime, invalid authority/input/receipt evidence and EVM
reverts cannot be overridden by asking another RPC for a nicer answer. A detected
finalized-checkpoint or bound-runtime conflict latches the runtime until operator
review and restart; cooldown, ordinary timeouts and validation reset cannot clear
it. Missing receipts alone remain pending, while failed checks after receipt
inclusion are reported unavailable rather than falsely pending or successful.
Existing finality, 90-second mint-admission freshness, wallet/session/CSRF,
explicit-price consent and durable submission-start gates are unchanged.

`/health` reports the policy, selected source label, observation source,
failover count, cooling sources and conflict flag without endpoint URLs or
private errors. This automatic **RPC** fallback is separate from the manually
started `pulse:sepolia:fe` frontend-only mode; that mode still never promotes
itself to minting. These checks run in the application, not in a Codex agent.
Hosted process supervision and release readiness remain separate work.

Regression verification: 108 Sepolia tests and 551 shared client/page/provenance,
reveal and Pulse tests pass, together with typecheck and whitespace checks.
Coverage includes primary-only operation, fallback takeover, recovery, whole-scan
restart, null receipt handling, finalized-conflict refusal, code/constructor/role
checks, concurrent validation reset/conflict races and refusal of effectful RPC
methods. A lagging finalized tag is unavailable, not conflicting, only after
the provider preserves the already-verified finalized anchor. An incomplete
receipt check cannot downgrade to pending because another provider has not
indexed the receipt yet. Two frozen-integration tests and the unchanged candidate
lock also pass. Live startup on temporary port 3005 used the secondary, reported a
healthy observer and returned the existing `anagentartist` mint as Minted over
HTTP 200. The full backend replaced the read-only frontend on port 3004, and
subsequent periodic reads recovered automatically to the primary. The final
restart also passed single-primary deployment verification and a healthy
incremental observer refresh. The funded deployer was not unlocked; no new mint, X/Grok request,
deployment, admin action or private environment edit was performed.

The final served-page check exposed another incomplete-data case: PublicNode
returned zero mint logs for the first 1,000 deployment blocks, while the pinned
fallback returned the three existing test mints. HTTP 200 alone is therefore not
a completeness signal. Before publishing a snapshot, the observer now compares
its full verified map to `freeMinted + getPulseState().epochIndex` at the same
pinned block (only `freeMinted` during the free phase). The frozen collection has
no burn path and advances that epoch exactly once per successful paid mint.
Too few logs are classified unavailable and retry the whole scan at fallback;
too many logs or a counter regressed below the verified prefix are conflicting
evidence, not a reason to choose a nicer source. Both-endpoint incompleteness
publishes nothing. The health output includes observed and expected mint counts.
These checks also cover incremental tails without dropping the finalized prefix.

Final live acceptance: the corrected bootstrap used the validated fallback and
recovered all four mints; a subsequent incremental refresh returned to the
primary with both observed and expected counts still four. All **46 GET-only
Chrome assertions** pass across inline mint reveal (desktop light/mobile dark),
the four-work home gallery, INFP collection (mobile light) and the mint form.
Every actual SVG, page, asset and session/status request succeeded. All five
screenshots were inspected: no overflow, no unavailable warning, stable Minted
badges and a styled enabled wallet-connect button. Browser initialization saved
only the public handle reference for the existing reveal; no wallet proof or
minted state was mocked. This verifies reads and presentation, not a new
installed-wallet mint. See [machine-readable evidence](validation/pulse-sepolia-failover-2026-09-29.json).

## Acceptance record

Verified September 27:

- Renderer and collection runtime/immutables, creation transactions and initial
  paused roles match the frozen build across both endpoints. Deployment receipts
  establish the initial state; current code/authority use a recent shared block.
  The collection was explicitly unpaused for the test.
- `SGSepoliaFree01` minted with slot 0; `SGSepoliaFree02` with slot 1, both to the
  same approved wallet. The second mint triggered `PaidPhaseStarted(Exhausted)`.
- `SGSepoliaPaid01` minted in Pulse epoch 1. Its price was 914285714285 wei
  (0.000000914285714285 Sepolia ETH), against the 100000000000000-wei cap.
  The unused amount was 99085714285715 wei. The collection retained zero ETH.
  Treasury and payer coincide in this fixture, so this is not an independent
  real-network test of a separate treasury's balance changes.
- All three receipts succeeded; owners, immutable inputs and embedded on-chain
  JSON/SVG metadata were checked. Gas used: 298868 / 320404 / 279067.
- Total actual gas fees for both deployments, unpause and three mints:
  **0.019925870971878109 Sepolia ETH**. No real ETH or provider credits were used.
- 17 focused planner/journal/client/read tests and 159 page/authorization/event
  regression tests pass; typecheck and the unchanged frozen candidate verifier
  pass. Client unit tests use a simulated provider, not an installed extension.
- The deployment is now finalized and the local port-3004 site started
  successfully. The old startup refusal also exposed unavailable deployment-time
  storage on the configured RPC. Recent agreed reads remove that archive-node
  dependency without dropping constructor, bytecode or two-source checks.
- Visual DOM/CDP checks on four pages pass: desktop light home, desktop dark
  minted detail, mobile dark mint entry and mobile light variations. All **20/20
  image instances** loaded; no horizontal overflow or failed asset requests.
  The home shows three finalized works; variations has one Minted and 15 Preview
  tiles. A favicon query-string routing error was fixed. Concurrent artwork
  requests now share one verified read, with failed reads evicted for retry.
- The real HTTP path accepted an actual SIWE proof from the approved test wallet;
  refused missing proof, bad CSRF, proof replay and user-injected MBTI; returned
  paid-phase options; prepared a correctly signed bounded mint; reused the exact
  prepared response; and showed all three currently owned works. Both RPCs
  successfully simulated that exact mint with `eth_call` at block **11790910**.
  Logout revoked the session. No begin/report call or broadcast occurred.

Machine-readable [local FE acceptance evidence](validation/pulse-sepolia-local-fe-2026-09-27.json)
records these scopes. The prepare-only check is reproducible via
`node --import tsx scripts/pulse-sepolia-web-check.mjs --prepare-only <new-handle>`.
It unlocks the approved wallet only to sign SIWE in its own process, creates one
durable prepared reservation and performs read-only EVM simulation. It never
signs or sends a chain transaction. The `SGWebQA0927` test reservation was left
prepared for traceability; do not clear or recycle it after expiry to hide a
failure. Use another unused handle for manual mint testing.

Source publication and local FE acceptance are now complete within this scope.
Installed-wallet approval/rejection, a fresh browser-broadcast mint and hosted
staging are not claimed by the prepare-only test. RPC transport can still have
transient failures; the page must not imply a successful or unminted state when
observation is unavailable.

Mint transactions:

| Handle | Transaction |
| --- | --- |
| `SGSepoliaFree01` | `0x0bcc6785cd7ce456cd41af0ed26a024a294f747f4ef576be0dee552981d2adda` |
| `SGSepoliaFree02` | `0x6466fdb28df5efc9cdd535d06ee138d26e79863a15670ca23ac95dab119f7c6e` |
| `SGSepoliaPaid01` | `0x1dd05fde3398f450b143c199ee320db9024f0b1ce7559521a893281c0ad8d205` |

## Try it now

1. Open **http://127.0.0.1:3004/mint** in a browser with your wallet installed.
2. Use a dedicated wallet with **Sepolia test ETH**, not the public Anvil key.
3. Enter an unused handle, connect/sign in, check the quote and select **Paid mint**.
   Both disposable free slots were consumed by the successful tests above.
4. Choose the maximum test-ETH payment (site ceiling: 0.0001 ETH, plus gas), then
   click **Mint & reveal** and review the wallet transaction.
5. Verified inclusion reveals inline on `/mint` and enters the galleries with
   **Confirming**; finalization updates it to **Minted**. Do not resubmit if the
   wallet outcome is uncertain.

MBTI is a deterministic fixture in this test runtime: no X/xAI request or charge.
The prior port-3003 preview site is unchanged and is not the Sepolia mint target.
Historical C7/C8 Anvil tests are not
relabelled as Sepolia tests. The real-Grok hosted staging and R5–R10 release gates
remain separate work.

## September 29: availability, durable presentation and automatic read recovery

This supersedes the historical startup/observer-coupling descriptions above.
It changes the dedicated disposable Pulse Sepolia site, **not** the older
`generative-v1-rc1` hosted runtime or its paused release/admission gates. No
Solidity, frozen renderer, pricing or canonical on-chain SVG storage is changed.

### Independent capabilities

- The HTTP server serves previews and cached public works before RPC startup
  checks finish. It no longer requires a manually launched frontend-only
  fallback to survive a transient RPC failure.
- Deployment certification, sale readiness, gallery synchronization and artwork
  population have separate read-only, single-flight recovery lanes. Normal
  passes run every 15 seconds; transient failures back off to at most 60 seconds.
  Sale/receipt reads have a 45-second budget, gallery passes 120 seconds and
  background artwork passes 60 seconds. Aborted/late reads cannot publish a
  successful result or overlap a successor pass.
- A history/log-range outage does not veto a healthy sale check. Preparation and
  the submission-start fence independently recheck the current pinned head,
  authorizer, wallet code, handle uniqueness, phase, pause, slot and chosen
  spending ceiling. The free slot must still equal the signed authorization's
  slot. No cached gallery or browser capability flag grants mint authority.
- Primary/fallback is the existing `validated-primary-fallback/v1` policy: one
  correctly validated source suffices. A failing primary may use a separately
  validated secondary; a successful fallback does not bypass conflicting chain,
  runtime, authority, canonical-header or finalized-mint evidence.
- Startup no longer loads the unfunded authorizer key. Only an explicit valid
  prepare request loads it. Recovery never calls X/Grok, signs a mint voucher,
  sends a wallet transaction, deploys, unpauses, changes settings or moves funds.

### Restart and UI behavior

`gallery-cache.json` in the existing private test-state directory stores selected
public mint identities, canonical anchors and bounded verified SVG bytes. Writes
are atomic/fsynced, permissions are 0600 and schema/checksum/deployment/input
bindings are validated. Corrupt or foreign presentation data is quarantined.
This is a derived local availability cache, **not** new canonical SVG storage,
compression or IPFS. Keys, session proofs, signed authorizations and prepared
transactions never enter this cache.

Saved finalized works remain visible with an unavailable-observation caveat.
Unfinalized works are shown with honest rechecking status during an outage. A
saved cursor is not trusted: every finalized receipt/input/artwork, its anchor
and the complete prefix count are revalidated before the observer can skip old
log ranges. Missing historical RPC data falls back to a complete scan, without
hiding already saved images or authorizing a mint from disk.

Genuine integrity/configuration conflicts halt effects and persist a separate
`gallery-safety-halt.json`, even before the first mint. Read success, cooldown,
UI reload and process restart cannot clear it. Operator recovery requires
reviewing the exact deployment binding and contradictory evidence first,
preserving the files for diagnosis, and only then explicitly archiving the
reviewed halt/cache state before a new verified bootstrap. There is no HTTP
"clear halt" endpoint. Do not delete a live process lock or saved submission
records to bypass verification.

The credential-free UI child process watches template, style, brand and client
edits and swaps renderers without restarting backend observation or wallet
sessions. A broken UI build retains the old renderer. A full backend restart
still expires the in-memory signed session; a UI-only edit does not.

Open pages poll `/api/test/capabilities` using GET only. They clear/reinstate the
availability notice, refresh only the gallery region and retry unavailable
image loads after recovery. The slogan, typed handle, wallet controls, price
choices and revealed result are retained. Returning from BFCache ignores late
checks from the previous page lifecycle. No automatic wallet prompt, consent,
preparation or resubmission is introduced.

### Operations and scope

- `/health/live`: 200 while this HTTP process is alive, even during RPC outage.
- `/health/ready`: 200 only with a verified binding, fresh non-paused sale check
  and no safety conflict; otherwise 503. It does not wait for the gallery scan.
- `/health` and `/api/test/capabilities`: capability details for liveness,
  gallery availability, observer freshness, mint readiness, recovery phase and
  sanitized cache/source diagnostics. They never contain credentials or RPC URLs.
- An external supervisor should restart a crashed process using **liveness**.
  Routing/admission may use readiness. Restarting a live process whenever a public
  RPC stalls discards useful state and worsens the outage. These endpoints do not
  install a hosted process supervisor or claim a production rollout.
- `pulse:sepolia:fe` remains an explicit offline inspection command, not the normal
  recovering server. It can show the same saved public works, never calls RPCs,
  cannot mint and never promotes itself. Normal use is `pulse:sepolia:dev`.

The paused R5–R10 hosted package still needs a reviewed Pulse runtime integration
and its own deployment/failure campaign. Its older two-source admission path is
not silently relaxed or activated by this local Sepolia change.

Verification: **127 Sepolia tests and 497 focused UI tests passed**, along with
typecheck, build, renderer/slogan locks and the unchanged Pulse candidate lock.
Live read-only startup used the validated secondary when the primary was
unavailable, observed all four works and recovered both readiness and gallery
health. A real restart served all four saved SVGs before fresh certification,
with an honest notice and mint readiness still false. Four isolated-browser
checks covered desktop/mobile light/dark and an automatic capability
outage/recovery cycle; screenshots were inspected, with no horizontal overflow
or failed recorded requests. The browser outage was simulated, not an installed
wallet or end-to-end new mint. No paid providers, wallet signatures, prepared
requests or chain transactions were used. See the
[machine-readable availability evidence](validation/pulse-sepolia-availability-2026-09-29.json).
