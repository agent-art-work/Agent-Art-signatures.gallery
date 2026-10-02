# Admin-configurable free mint: disposable Sepolia test

This run deploys `SignaturesPulseMintV1RC2`, profile
`generative-pulse-v1-rc2`. It does not reopen or modify the older RC1 sale.
It reuses the verified renderer at
`0x954b4Ee81F46a04435792A6deeA5126F058b13C1` and binds the canonical Sepolia
Pulse Core. These are test settings, not approval for a production launch.

## Live test deployment — 2026-10-02

Collection: [`0x0787b0E511D1E73E6eBEd03104A199e6620eeBB2`](https://sepolia.etherscan.io/address/0x0787b0E511D1E73E6eBEd03104A199e6620eeBB2).
Sourcify reports exact creation and runtime matches; its 35 published source
files and original compiler metadata were read back and compared with the local
build. [Verified source](https://repo.sourcify.dev/11155111/0x0787b0E511D1E73E6eBEd03104A199e6620eeBB2).

The current policy is revision two, capacity four, quota four, with one successful
free mint. Wallet `0x170AF4D923De5E3155067e104134C3b11d82E100` has two unused slots
(IDs two and three). Free minting ends on quota exhaustion or
**2026-10-09 10:09:36 UTC**, whichever comes first. A new handle is required for
each token, including repeat slots held by the same wallet.

Run the separate frontend with:

```sh
npm run pulse:sepolia:admin:dev
```

Open `http://127.0.0.1:3007/mint`, connect the allowlisted wallet on Ethereum
Sepolia and enter a new handle. The page checks the wallet's free slot automatically. A free mint costs zero
mint price, but requires Sepolia ETH for network gas. This origin uses a separate
deployment and browser session from the previous RC1 frontend at port 3004.
The site waits for deployment finality and full verification before admission;
`/health` exposes operator-only readiness and recovery diagnostics.

This disposable frontend uses a deterministic assessment fixture, not live Grok.
The real contract, allowlist proof, revision-bound authorization and transaction
receipt are verified. No paid X or Grok requests are made by this test run.

## Policy

The admin may change the Merkle allowlist root, slot capacity and successful
free-mint quota while the contract is paused and the free phase is still open.
One slot permits one successful token mint. Repeat an address in separate rows
to grant that wallet multiple slots. The wallet pays transaction gas; the mint
price of a free slot is zero.

The ordered wallet file defines stable slot IDs starting at zero. New rows
append IDs. Existing, unclaimed rows may be reassigned only after checking their
claim state at a concrete canonical block and rechecking immediately before
delivery. Claimed rows cannot be reassigned by the operator tool, and the
contract never clears claimed bits. Slot capacity cannot shrink.

The quota must be at least the number of successful free mints and no greater
than the slot capacity. Setting it equal to the successful mint count ends the
free phase immediately, including setting zero before any mint. Exhausting the
quota or reaching the original deadline also ends free minting, whichever comes
first. Paid minting can never be changed back to free minting. The deadline is
immutable; updating the allowlist does not extend it.

Each update increments `freeConfigRevision`. Free authorizations must match the
current revision, so a stale signature cannot be combined with a replacement
proof. Paid authorizations use revision zero. The immutable `saleConfigHash`
commits the initial deployment settings; subsequent policy revisions have their
own `FreeMintConfigured` event hash.

## Operator run

### Admin page

Open `/admin` on the separate RC2 frontend (normally
`http://127.0.0.1:3007/admin`). Connect the contract's admin wallet on Ethereum
Sepolia and sign the admin sign-in message. A normal minter wallet cannot read
the private ordered allowlist or prepare admin changes.

The page displays the live quota, successful free mints, slot capacity, phase,
pause state and original deadline. Edit the full ordered wallet list and quota,
then review the new Merkle root and change counts. Append new addresses without
reordering existing slot IDs; repeating an address grants multiple slots.

Each chain write needs a separate click and wallet approval: pause minting,
apply the reviewed allowlist/quota, then resume minting. The server prepares
validated calldata but never unlocks the funded admin key, signs or broadcasts
these transactions. Configuration proofs are activated only after validating
the matching successful receipt and resulting chain state. Unknown submissions
stay recoverable by their transaction hash; they are never resent automatically.

Setting quota equal to the already successful free-mint count permanently ends
the free phase. The page requires an explicit acknowledgement for this change.
The immutable deadline cannot be extended and a paid phase cannot be reopened.

### Command-line alternative

The approved funded deployer is
`0x3e4fA9f09d8EDe66561145E1ef3bc127F80ED396`. The existing private Sepolia
keystore context supplies custody; no private key belongs in these commands or
in Git. A separate mint-authorizer key is generated for this run.

Optional process-local overrides select HTTPS RPC endpoints without modifying
the existing environment file:

```sh
export SEPOLIA_ADMIN_RPC_URL=https://sepolia.gateway.tenderly.co
export SEPOLIA_ADMIN_SECONDARY_RPC_URL=https://eth-sepolia.api.onfinality.io/public
node --import tsx scripts/pulse-sepolia-admin.mjs prepare
node --import tsx scripts/pulse-sepolia-admin.mjs deploy --broadcast
```

Use healthy endpoints appropriate to the operator environment; these public
examples are not availability guarantees. Distinct hosts are required. Ordinary
checks use one validated source, pinning the entire semantic read to that source.
An unavailable source may trigger a complete read retry at the fallback, never a
mixture of partial results. Broadcasts use only the explicitly chosen primary,
which is separately checked for Sepolia chain/genesis and exact Core identity
before signing and delivery. An unhealthy fallback is not a quorum prerequisite
for ordinary operation. No RPC URL or private error payload is printed.

Initial deployment has two deployer slots, quota two, a seven-day deadline and
minting paused. To test an admin update before opening the sale, create a private
ordered wallet file containing these four lines:

```text
0x3e4fA9f09d8EDe66561145E1ef3bc127F80ED396
0x3e4fA9f09d8EDe66561145E1ef3bc127F80ED396
0x170AF4D923De5E3155067e104134C3b11d82E100
0x170AF4D923De5E3155067e104134C3b11d82E100
```

Then apply quota four and open minting:

```sh
node --import tsx scripts/pulse-sepolia-admin.mjs configure .local/pulse-sepolia-admin-v1/wallets.txt 4 --broadcast
node --import tsx scripts/pulse-sepolia-admin.mjs unpause --broadcast
node --import tsx scripts/pulse-sepolia-admin.mjs smoke --broadcast
node --import tsx scripts/pulse-sepolia-admin.mjs inspect
```

The update is revision two. The smoke test mints exactly one deployer slot for
`SGSepoliaAdm01`, verifies its receipt, ownership, authorization digest, inputs,
free economics and rendered SVG, and leaves three slots unused, including both
slots for `0x170AF4D923De5E3155067e104134C3b11d82E100`. It uses a controlled MBTI
fixture and makes no X or Grok requests. Fixture wording is operator evidence,
not visitor-facing UI copy.

Later address/quota changes use `pause --broadcast`, then `configure`, then
`unpause --broadcast`, provided free minting has not ended. `configure` takes the
full ordered list, not only newly added addresses. Reapplying the current root
and quota is idempotent.

For a separate independent audit when both endpoints are healthy:

```sh
SEPOLIA_ADMIN_AUDIT_SOURCES=2 node --import tsx scripts/pulse-sepolia-admin.mjs inspect
```

That explicit audit compares both sources. Ordinary verification records its
actual source count and does not claim a two-source quorum.

To check real HTTP authentication and free authorization preparation without
minting another token, use a fresh test handle:

```sh
node --import tsx scripts/pulse-sepolia-admin-web-check.mjs --prepare-only SGAdmWeb01
```

This signs only the deployer's site-login message, checks the current Merkle
proof and RC2 signature, and uses block-pinned `eth_call` simulation. It never
starts submission, signs a transaction, or broadcasts. Its endpoint allowlist
excludes submission and recovery endpoints. Readiness refreshes are bounded,
read-only demand wakeups; integrity mismatches stop the check. The prepared
reservation remains in the private run records for traceability. Do not clear
it or reuse its handle for another acceptance run.

## Records and recovery

All run records are in `.local/pulse-sepolia-admin-v1`, separate from the active
`.local/rehearsal` environment and all previous Sepolia runs. The directory is
private. It contains the plan, authorizer key, journal, deployment binding,
current `free-config.json`, and smoke evidence. Only a validated configuration
artifact is published for site/backend proof generation.

Every write requires `--broadcast`. The journal stores the exact signed bytes,
nonce, hash and bounded fee exposure before delivery. A lost RPC response is
recorded as delivery-unknown, not as a failed transaction. Resume the exact same
command after inspection: an included transaction is not sent again, and an
unknown transaction can only be explicitly redelivered unchanged at the same
nonce. There are no automatic new nonces, replacements, fee bumps or write
fallbacks. Reverted transactions stop; investigate rather than deleting their
journal entry. An operation lock prevents concurrent writes.

The test budget is at most 0.15 Sepolia ETH of summed worst-case signed exposure,
20 gwei maximum fee per gas, 1 gwei priority fee and 8 million gas per transaction.
The tool also checks pending/latest nonce consistency and sufficient balance.
These are test-ETH bounds, not a real-money mainnet spending authorization.

## Local regression checks

```sh
node --import tsx --test contracts/tools/pulse-sepolia-admin-plan.node-test.mjs contracts/tools/pulse-sepolia-admin-execution.node-test.mjs
node --import tsx --test contracts/tools/pulse-sepolia-admin-web-service.node-test.mjs contracts/tools/pulse-sepolia-admin-web-http.node-test.mjs contracts/tools/pulse-sepolia-admin-page.node-test.mjs contracts/tools/pulse-sepolia-admin-client.node-test.mjs
forge test --root contracts --match-path test/SignaturesPulseMintV1RC2.t.sol
```

The Node tests use mocked RPC and a public test private key; they do not submit
transactions or use the approved deployer. They cover ordered slot updates,
claimed-wallet protection, quota/phase bounds, exact journal recovery, fees,
receipt integrity, pinned fallback reads and primary-only writes. Foundry covers
the RC2 contract's authorization revision, admin roles, pause requirements,
claimed bitmap, irreversible free-to-paid transition and paid economics.

The admin-page checks cover wallet sign-in, current roles, origin/CSRF controls,
bounded ordered lists, review invalidation, deliberate pause/apply/resume,
claimed-slot protection, canonical receipts, pending recovery and superseded
requests. All 71 focused tests passed. Desktop and mobile browser checks also
passed using simulated wallet transactions. A separate read-only Sepolia check
verified the finalized deployment, admin role and revision-two four-slot policy
(one free mint used of quota four). No live admin transaction was submitted.

The complete Vitest regression run passed 6,166 tests (625 opt-in/skipped tests).
The Sepolia Node suite passed 360 tests with one PostgreSQL test skipped by
default; that isolated PostgreSQL test was run separately and passed. Additional
prepare-only HTTP guard tests cover readiness recovery, exact signatures/proofs,
single-source simulation and endpoint fencing. These tests do not turn this
disposable deployment into a production release approval.

Live HTTP acceptance for `SGAdmWeb01` passed at 2026-10-02 10:37:46 UTC:
real deployer SIWE, zero-price free eligibility, current revision-two proof and
authorizer signature, exact prepared retry reuse, and primary-source simulation
at block 11828435. Mint, slot and nonce state remained unchanged; submission
was not started. The existing minted fixture was visible in the collection and
signature detail pages. Desktop/mobile browser checks found no horizontal
overflow, missing image/assets, or visible mint outage warning after readiness.
