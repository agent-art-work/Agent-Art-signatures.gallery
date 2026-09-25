# Open-mint sharing and indexing boundary

**Historical saved-artifact foundation.** The helper described below remains
unwired and tested for that older profile; its saved-PNG/CID policy is not the
current generative design. The separate [generative staging integration](generative-staging-sharing.md)
now supplies canonical URLs, OG/X metadata and bounded read-time PNGs through
the locally rehearsed future-staging site. It uses pinned on-chain inputs and
verified finality, not saved-artifact/IPFS publication. The ordinary local
server still has no new social metadata. Public indexing remains unapproved.

This is a bounded E22 policy foundation, not public indexing activation. Ethereum Sepolia and `https://staging.signatures.gallery` are the selected staging network/origin. No DNS/hosting, sitemap, crawler integration or public server startup has been enabled. Staging remains noindex.

## Active local runtime

Every response from `createOpenMintServer` now carries `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, including assets, APIs, redirects and errors. `GET /robots.txt` returns `User-agent: *` plus `Disallow: /` with `no-store`, before session creation or service calls. Host validation still runs first. The server does not emit new canonical or social metadata, change its page layout, or alter its approved wording. The existing public-start refusal is unchanged.

Robots instructions are not authentication, secrecy, or guaranteed removal from search engines. Private capabilities, sessions and authorization checks must remain the actual access boundary. `no-store` remains mandatory for private responses.

## Unwired future policy

`src/openMint/sharing.ts` exports a pure asynchronous `openMintSharing` policy. Local, staging, missing, unknown and malformed profiles always return noindex/no-store with no canonical URL or card image. An explicitly supplied `public-approved` server configuration must include an exact syntactically public HTTPS origin, a validated deployment profile and an explicit `indexConfirmedWorks` boolean. The label is a configuration contract, not proof of operational approval; it must never come from request parameters. There is no default origin or default permission to index.

The policy recognizes only these exact public path shapes:

| Input | Canonical/card behavior | Indexing |
| --- | --- | --- |
| `/p/<preserved-handle>/<UPPERCASE-MBTI>` with an exactly matching valid free-preview model and current renderer | Canonical URL and free-preview OG/X PNG descriptor; clearly not an assessment or mint | Always `noindex, follow` |
| `/signatures/<canonical-lowercase-handle>` with a trusted confirmed, available projection and verified matching saved public artifact | Canonical URL and exact saved PNG hash URL; original verified spelling and saved MBTI | Only the explicit `indexConfirmedWorks` choice can return `index, follow` |
| Everything else, including mint/request capabilities, `/me`, APIs, pending/unknown/halted records, unavailable/quarantined artwork, or any query/fragment-bearing path | No canonical URL, image, OG or X card | `noindex, nofollow, noarchive, nosnippet` |

Home, MBTI galleries, aliases, editable variations and sitemap enumeration are deliberately not implemented by this bounded policy. Unknown paths fail closed, rather than gaining metadata from a supplied artifact. Private paths are rejected before inspecting artifact data. Query/fragment credentials are never stripped into an apparently public canonical URL.

## Saved-artwork binding and privacy

Minted metadata requires an exact deployment/namespace/chain/contract/manifest/finality-policy match. It validates saved SVG, PNG and metadata descriptors, bytes, hashes and CIDs through `verifyPreparedPublicArtifact`, then matches the projected token ID, canonical handle, MBTI, assessment digest, artifact digest and token-URI hash. Missing recipient/owner fields, invalid addresses and zero addresses are rejected. All relevant input is snapshotted before asynchronous verification. It does not regenerate minted images using mutable current settings or substitute a preview when integrity checks fail.

The projection input must come from the trusted coordinator/repository after canonicality, finality, completeness and freshness validation—not browser JSON or raw RPC assertions. The existing projection foundation itself requires that upstream evidence; this sharing helper does not manufacture it. Future integration must invalidate sharing on unknown, halted, stale, reorged or quarantined state. This is why even accepted public metadata currently specifies `no-store`: shared-cache policy and invalidation remain to be reviewed.

Social fields are an explicit allowlist and HTML-attribute escaped. They use only approved descriptive text, public spelling/MBTI, canonical URL and a public image URL. No session, capability, CSRF token, wallet address, nonce, provider response ID, operational reference, source-query secret or full private assessment is serialized. Preview cards never inspect or expose a pending paid assessment; their description identifies the MBTI as a chosen artistic input.

## Remaining integration

The free-preview PNG descriptor uses a proposed `/sharing/previews/<handle>/<MBTI>/<renderer-version>.png` route. That endpoint is **not implemented or served by the active server**. A future reviewed adapter must render the exact validated free preview locally, bound generation/cache work and serve the matching PNG without assessment/provider calls. Minted cards reference `/artifacts/<verified-saved-png-sha256>.png`; public deployment must serve those exact verified published bytes and preserve immutable mappings.

Before public activation: approve origin/deployment/indexing policy, complete canonical/finality observation integration, implement and verify public PNG delivery and failure behavior, decide cache invalidation, and test real crawler/card rendering. A future sitemap may enumerate only approved confirmed public records and bounded galleries; it must never enumerate capabilities, private collections, preview permutations, pending works or unapproved environments. No sitemap or public route wiring was added here.

## Offline evidence

`npx vitest run src/openMint/sharing.test.ts src/openMint/server.test.ts` covers environment switching, exact route/preview validation, privacy denial, stored-artwork integrity/deployment binding, immutable snapshots and the active robots/header guard. Tests use synthetic saved-artifact fixtures and the HTTP listener's in-memory stream harness. No crawler, browser wallet, RPC, live provider or public host was used. `npm run typecheck` also passes.
