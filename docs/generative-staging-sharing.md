# Generative staging sharing and indexing

September 23, 2026. E22 is integrated in the **locally rehearsed future-staging
site**, not deployed or activated. No paid calls, live credentials, public
transactions, DNS/TLS changes or active rehearsal/backup changes are involved.

## Exact environment and source

`createStagingGenerativeSharing` accepts only the approved
`https://staging.signatures.gallery` origin and a validated Sepolia RC1
generative deployment. It captures that binding; URL parameters, forwarded
hosts and page options cannot select an origin, renderer or indexing policy.
`createStagingSite` supplies models from its co-bound verified artwork
reader. Structural model checks do not create chain-observation authority.

The ordinary local factories remain undecorated. There is no public-approved
mode, environment auto-detection, fallback to the historical saved-artifact
sharing helper, or IPFS dependency. Preview rendering stays on locked
`sg-renderer-2.0.0`; minted artwork comes from the pinned immutable EVM renderer.
The separate slogan renderer is unaffected. No finished output is stored or
included in mint authorization; PNG conversion is read-time delivery only.

## Page policy

Every response retains `no-store` and `noindex, nofollow, noarchive, nosnippet`.
`robots.txt` disallows all crawling; `/sitemap.xml` returns 404, with no
enumeration. Robots and cache directives are requests to clients, **not access
control** or a guarantee that a crawler will forget a previously fetched card.

| Page | Canonical and OG/X metadata |
| --- | --- |
| `/`, `/about`, `/<MBTI>/` | Fixed staging canonical and descriptive text, no arbitrary gallery image |
| `/p/<preserved-handle>/variations` | Variations canonical and text, no inferred assessment or selected image |
| `/p/<preserved-handle>/<MBTI>` | Explicit **free preview**, chosen MBTI, current locked preview PNG |
| Selected preview alias for a finalized mint | Canonical `/signatures/<lowercase-handle>` and the minted card, after verified-casing redirect |
| `/signatures/<lowercase-handle>` finalized | Preserved spelling × authoritative MBTI, verified pinned chain-rendered PNG |
| Selected alias or detail while **Confirming** | On-page reveal continues; no canonical, OG or X card |
| `/mint`, private progress, `/me`, APIs, unknown/errors and query/fragment-bearing paths | No canonical, OG or X card; no private data promoted into metadata |

The other fifteen variations remain editable previews even after a mint. A
failed mint-status read cannot turn a preview into a verified mint. Gallery
pagination does not strip a query into a canonical URL. Existing redirect and
caption/link behavior is unchanged.

Social fields are an escaped allowlist: public handle, MBTI, descriptive text
and bound page/image URLs. No session, capability, wallet, nonce, CSRF value,
provider receipt, private assessment or diagnostic reference is serialized.
Confirmed detail metadata additionally checks token/handle identity, renderer
profile, input commitment, chain-image route and absence of old artifact fields.

## Image delivery and shutdown

- `/sharing/previews/<handle>/<MBTI>/sg-renderer-2.0.0.png`: render the exact free
  preview locally. No provider, wallet, signing or chain request is needed.
- `/sharing/signatures/<lowercase-handle>/<input-digest>.png`: require current
  finalized projection evidence before chain reads; verify pinned inclusion,
  inputs and output, rasterize the recovered SVG, then recheck the exact
  projection/freshness. A finality contradiction, stale observation or lost
  authority returns unavailable, never a preview substitute. Normal on-page
  media still permits verified Confirming reveal.

GET only; no query, fragment or body. Routes/handles/MBTI/version/digest are
strictly validated before rendering. At most two concurrent image jobs, no
queue, a five-second response deadline, two-second native raster timeout,
1080² pixel limit and two-MiB PNG response ceiling bound the work. Cancellation
does not prove completion: timed-out work holds its slot until it settles.
The shared artwork reader and image handler expose drains of underlying work;
site close waits for them within its existing bounded shutdown. An incomplete
drain still requires retaining writer ownership.

The enclosing staging transport supplies its independently checked Host/proxy
and request limits. Direct image responses also set restrictive CSP, nosniff,
no-referrer and the same cache/robots policy. Errors are sanitized. There is no
CDN/cache policy that could silently outlive withdrawn finality.

## Verification

All **216 focused tests pass**, including real disposable-PostgreSQL projection
cases. Both measured files have 100% statements/lines/functions; sharing has
97.27% branches and the verified artwork reader 98.55% (97.76% combined).
The **711 local page/client/site/legacy-sharing regressions also pass**.
All **59 runtime/site integration tests pass**, with no skips or cancellations.
Runtime/HTTP coverage remains 100% lines, 97.17% branches and 96.77% functions;
the existing 100/94/95 gate passes unchanged (site source is not included in
that measurement). This increment verifies **986 distinct passing tests**,
three browser flows and two additional card checks. Build, typecheck, original
renderer/slogan locks, RC1 lock, syntax and whitespace checks pass. Temporary
test services closed normally; RC1 remains `candidate-not-approved` and hosted
CI has not been observed.

Focused coverage tests exercise environment refusal, every MBTI, exact preview
PNG bytes, minted model binding, metadata privacy, invalid methods/routes,
concurrency, abort/deadline behavior, retained capacity and shutdown draining.
The artwork-reader tests cover finality changing during image reads. Existing
local pages and legacy sharing policy are regression-tested separately.

Real disposable PostgreSQL/HTTP integration adds cards to the complete
preparation → wallet permit → canonical Confirming → finalized flow. It checks
that Confirming/private metadata is absent, finalized PNG equals ordinary
chain-rendered PNG, the selected preview alias canonicalizes to the minted
work, and a finalized-history contradiction withdraws image delivery. Public
browsing/card reads leave assessment, signing and wallet-dispatch counts alone.

The three scripted-wallet browser scenarios pass, plus preview/minted metadata
and PNG decode checks. Both PNGs decode as 1080×1080. Six screenshots inspected:
mobile/dark Confirming, signed-out entry and withdrawn-review progress;
desktop/light finalized gallery, alternative preview and finalized detail.
No horizontal overflow. The visual-dom-cdp skill provides the DOM/network and
screenshot checks; actual PNG bytes are also checked by tests. Synthetic minted
SVG/RPC fixtures prove delivery and boundaries, **not** EVM renderer parity or
real Grok assessment. No external browser requests or broadcasts occur.

Reproduce with PostgreSQL 16 and Chrome, without real credentials:

```sh
OPEN_MINT_TEST_POSTGRES=1 OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run test:generative:staging-sharing
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run test:generative:staging-runtime
OPEN_MINT_TEST_POSTGRES_BIN=/path/to/pg16/bin npm run generative:staging-browser -- --visual-tool /absolute/path/to/verify-page.mjs
```

CI includes the new **per-file 100% statements/lines/functions and 95% branches**
gate for sharing and verified artwork delivery. The broader runtime/HTTP gate
is unchanged. Ignored evidence is in `.local/generative-renderer/`:
`staging-sharing-*` logs/coverage and refreshed `staging-browser-*` JSON/images.
Private test capabilities/cookies do not belong in committed evidence.

## Remaining gates

Staging canonical/card integration is implemented; public indexing is not.
Hosted TLS/proxy acceptance and actual crawler/card behavior require a hosted
environment. A future approved production origin/indexing/cache/sitemap policy
must be explicit; do not infer it from these staging constructors.

Next safe work is a consolidated release-readiness audit: reconcile completed
local evidence with remaining provider entitlement, claim wording, mobile and
wallet acceptance, operational ownership/support/restore and exact deployment
decisions. It must separate implementable gaps from user/external gates, not
invent further guard layers or treat green local tests as release approval.
Provisioning, funding, Sepolia deployment, custody changes, additional paid
dispatch, RC1 approval and launch remain separate authorizations.
