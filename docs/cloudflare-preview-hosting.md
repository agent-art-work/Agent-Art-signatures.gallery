# Cloudflare preview hosting

This runbook covers the public prelaunch website at `staging.signatures.gallery` and `signatures.gallery`. It serves previews and documentation only. It does not deploy or activate the mint backend, the chain relay, wallet connections, X or Grok requests, a database, or mint credentials.

Operational ownership belongs to central OPS (`/Users/bigu/Projects/inshell-ops`, chat `019eca52-9896-7190-ae8d-38d647291242`), which accepted the completed handback on October 4, 2026. This repository/chat retains development, tested build artifacts and technical release instructions; OPS coordinates provider changes, deployments and recovery verification. Provider and release details below are the recorded handback baseline, not a fresh live audit. Further OPS implementation remains paused, and this handoff grants no new provider, billing, credential or signing authority. See [ownership and outstanding verification](site-ops.md#ownership-handoff); do not independently resume provider-monitoring or email follow-through from this chat.

## Account and deployment status

On October 3, 2026, the signed-in Chrome session showed the Cloudflare account `This.agent.art@gmail.com`, account ID `a54e5847cc16e612aa3ad45a5dadb563`. The `signatures.gallery` zone is active, with zone ID `0531405cf3b989a9d187c7383ad846a3`. At inspection, the zone had no DNS records and no connected Workers; the account's Workers and Pages inventory also showed no projects.

Staging and production are publicly live in preview-only mode. On October 4, 2026 (Asia/Shanghai), the user chose the existing Cloudflare Free tier and explicitly authorized production publication after reviewing the CPU limitation below. No billing upgrade was made. On October 3, the user approved Wrangler's account/user/zone read access, Worker script/route write access and refreshable login stored in the OS keychain, solely for these two preview-only sites. The user also confirmed the final Authorize action. Device-code authorization succeeded, and `wrangler whoami` verified the intended account and approved scopes. The login is encrypted locally, with its encryption key in macOS Keychain; do not copy or inspect the credential values.

The previous localhost error came from Wrangler's two-minute OAuth callback timeout, not from the website. Device-code login removes that localhost callback. Reusing an expired consent URL cannot repair it.

Initial-launch staging and production packages had verified complete file manifests and identical Worker bytes. Typecheck, all 204 preview unit tests, 13 packaging checks and both real `workerd` tests passed. Renderer locks and staging deployment dry-run also passed. Public staging home, About, agent documentation, all 16 preview images, fonts, readiness, HTTPS redirect and indexing checks passed. Desktop and mobile browser checks confirmed loaded Playpen Sans, no horizontal overflow, working navigation and no wallet-connect or mint controls. The newer Ops release and its expanded checks are recorded below.

| Environment | Worker | Exact origin | Search policy |
| --- | --- | --- | --- |
| Staging | `signatures-gallery-staging` | `https://staging.signatures.gallery` | No indexing |
| Production prelaunch | `signatures-gallery` | `https://signatures.gallery` | Public documents indexable; mint, collection, errors and APIs remain noindex |

The repository is now `agent-art-work/Agent-Art-signatures.gallery`. This hosting package is independent of the active local rehearsal environment; do not modify `.local/rehearsal` during deployment.

## Public package boundary

The package exposes the home page, About the work, the explorer, all 16 MBTI collection pages, deterministic preview pages and SVGs, agent documentation, health, robots and sitemap. `/mint` is an explorer while the site is in prelaunch. `/me` explains that collections open with minting; it does not request wallet access. All `/api` paths refuse mint operations with `SITE_NOT_OPEN`.

Only `ASSETS` and `PUBLIC_ORIGIN` are configured. There are no secret, database, RPC, queue or contract bindings. The browser's content security policy forbids network connections. The client supports local input persistence, styled validation, prompt copying and the preview-mode wallet notice; it cannot sign, connect a wallet or submit a transaction.

The build includes the unchanged locked renderers, the generated site icon and slogan scripts, and all 16 self-hosted Playpen Sans font subsets with their license. Public font constants are embedded at build time, so the Worker does not read the filesystem. Successful HTML revalidates on every use and carries `no-transform` to prevent Cloudflare's automatic analytics beacon injection; CSP is not relaxed. Health, API and error responses remain `no-store`. CSS and client JavaScript revalidate on each use; other assets and preview SVGs use a five-minute cache.

## Build and test

Install the pinned dependencies with `npm ci`, then run:

```sh
npm run typecheck
npm run test:preview
npm run preview:build -- staging
npm run preview:build -- production
```

The packaging tests run the bundled Worker and asset binding inside Cloudflare's local `workerd` runtime, without external network access. They check both origins, the exact rendered SVGs, fonts, headers, indexing and refused mint APIs. Unit tests alone are not deployment acceptance.

Each build prints a new artifact directory under `.local/preview-cloudflare/`. Never reuse or overwrite an existing artifact directory. `manifest.json` records every packaged file's size and SHA-256; the Worker digest must match across staging and production. `wrangler.json` fixes the account, hostname, compatibility settings and preview-only bindings. `metafile.json` records the bundled dependencies and default-only Worker entry point.

The initial launch used `.local/preview-cloudflare/staging-BSR1AQ` and `.local/preview-cloudflare/production-a920mV`. The October 4 fresh builds (`staging-n64g3j` and `production-a920mV`) were byte-identical to their respective October 3 packages, including all 25 manifest entries. Both initial Workers had SHA-256 `178e1637057ccabd11fe46b25c6e940db271cf24ec31f63f2e5e7ea521ec1167`. Their manifest SHA-256 values were respectively `d9f324f2dcecb050cb42f83a42db4f84370a5ed6c29fd110569c7c7530abb4c5` and `51c2430ce86e8159299d3db0ab825ce837e6edc9b7069b83cabcc1aec42812d9`. These artifacts remain intact for rollback, along with the earlier prepared `production-GLghkn`. Current Ops artifacts are recorded below. Ignored build files are not a substitute for a source commit.

At initial launch, both packages were built from HEAD `9dd031c5e6e4774613a470b17cd270c19ef7b6db` plus then-uncommitted preview/UI work. That historical HEAD alone does not reproduce the deployment. Retain the complete original artifacts and manifests. The reproducible source checkpoint for the newer Ops release is recorded below. Rebuild if source changes; never overwrite an old artifact.

## Staging deployment record

| Deployment | UTC time | Version ID | Deployment ID |
| --- | --- | --- | --- |
| Initial preview package | 2026-10-03 14:37:16 | `4b51665e-36f4-4b9f-85c2-5301459d5e71` | `3479daf5-ed5e-4490-9086-1a7c0504f07d` |
| HTML analytics injection prevention | 2026-10-03 14:46:27 | `eab49592-c7dc-4a22-95e8-08fddde5e6c9` | `3df11b8b-9e36-4011-bd60-17244a73aaf9` |

The latter version received 100% of staging traffic until the Ops release below. Its only bindings were `ASSETS` and `PUBLIC_ORIGIN`, and it remains the previous verified rollback version. Production is recorded separately below. No billing change, backend activation or rehearsal-environment change occurred.

After that deployment, fresh desktop and mobile browser checks found no analytics beacon markup and no external requests. All 16 images for a 15-digit handle loaded and matched the local renderer exactly. The reference `Alice_Bob_Key/INTJ` SVG remained 6,737 bytes with SHA-256 `a1b7b713d80b8f7040b67782b69ae7a0e779cebacc20f4abd48f5ce324f70ea8`; the Latin font remained 196,412 bytes with SHA-256 `58fbf15e1104dc4c3a7e11820743a14330bcb82c9b6e2e56af7162c9f3d5fcd3`. Readiness still reports all six expected preview-only fields.

## Production deployment record

| Deployment | UTC time | Version ID | Deployment ID |
| --- | --- | --- | --- |
| User-approved Free-tier preview launch | 2026-10-03 23:14:56 | `6a264ee8-7947-44c2-a927-2b67d576727a` | `504a396a-0dea-4fdd-bf97-052ab0367f87` |

This is October 4, 2026 at 07:14:56 in Asia/Shanghai. The version received 100% of production traffic until the Ops release below, is tagged `preview-free-launch`, and uses the exact initial production artifact above. It remains the previous verified production rollback version. Before publication, the account inventory contained only the staging Worker and the domain's DNS contained only its staging Worker record; no unrelated production record was replaced. The production custom domain and managed certificate were created by the approved deployment.

Wrangler's post-publication version inspection confirms a fetch-only handler with `ASSETS` and `PUBLIC_ORIGIN` (`https://signatures.gallery`) as its only bindings. Public readiness returns HTTP 200 with `live=true`, `frontendOnly=true`, `siteLaunchMode=prelaunch`, `mintingEnabled=false`, `walletConnectionEnabled=false` and `rpcEnabled=false`. This release is not mint-ready.

Post-publication acceptance passed 142 of 142 public checks across both hosts. Home, About, agent documents and three prompts, explorer, all 16 MBTI galleries, fonts and static assets match the exact release. Each host's 16 previews for a 15-character numeric handle and the reference `Alice_Bob_Key/INTJ` SVG match the locked local renderer byte-for-byte. HTTPS redirects, production canonicals and indexing, staging noindex, CSP and analytics-injection prevention pass.

Seven fresh, cache-disabled production Chrome runs passed: desktop home, About and variations at 1440 × 1000, plus mobile explorer and variations in both light and dark modes at 390 × 844. All 99 captured requests returned HTTP 200 and stayed on-origin. Playpen Sans loaded, every variations run loaded all 16 images, and there were no horizontal overflows, failed resources, analytics beacons or wallet/mint actions. Screenshots were inspected alongside these DOM and network checks.

The launch follow-up automation remains paused at the user's request. Publication and these launch checks are manual; no recurring uptime checks or automatic paid upgrades were enabled.

## First Ops release — October 4, 2026 (Asia/Shanghai)

The user requested a minimal Ops baseline using mature services and email notifications, with application work only for necessary gaps. [Site Ops](site-ops.md) records the native protection rule, incident response, saved Cloudflare policies and independent checks. Production server-failure policy `01f7faed2c2e4b82a1d9991656c50313` and account-wide HTTP DDoS policy `17e9937902f044579d6f2345abef8c23` are saved and Enabled to `this.agent.art@gmail.com`; one native test was requested for each, but human delivery confirmation remains pending. The user completed sign-in to the existing Agent Art UptimeRobot account, which showed 0 of 50 monitors before these additions. Four five-minute, case-sensitive keyword monitors were created there with the approved `this.agent.art@gmail.com` contact, default GET and no delay / no repeat: production readiness `804165852`, staging readiness `804165861`, homepage `804165864` and generated SVG `804165869`. All four saved details and contacts were inspected, and the final provider list showed all four Up with five-minute intervals and 100% uptime over their short initial history, 0 Down, 0 Paused and 4 of 50 slots used. All four targets also passed ordinary public HTTP 200/content checks. One native notification test on SVG `804165869` produced `Test notification sent`; on October 4, 2026 (Asia/Shanghai), the user confirmed that both simulated DOWN and UP emails arrived. UptimeRobot first checks and test email delivery are verified; this is not a real outage drill or a future delivery guarantee. Cloudflare's separate test receipts remain unconfirmed. Initial unattached entries in the separate `3kg3kg@gmail.com` account remain historical and untouched. No new account, billing, subscription, login-email or access change occurred.

This release changes static routing to assets-first and skips SVG generation for validated HEAD requests. Exact per-file `_headers` preserve security, cache and staging noindex headers without invoking the user Worker for existing assets. HTML and not-found fallbacks remain disabled. Static query strings safely return identical packaged bytes; dynamic authority/path/query checks remain enforced. Zone-level Always Use HTTPS now redirects direct assets as well as pages. The native rate-limit rule excludes only exact published static paths, not the entire `/assets/` prefix, so missing-file requests do not bypass its counter.

| Environment | UTC deployment time | Version ID | Deployment ID | Artifact |
| --- | --- | --- | --- | --- |
| Staging | 2026-10-03 23:55:13 | `29e75748-bf05-4141-82e6-79446794d882` | `9bcf51f6-f422-473d-848d-7d9bac289947` | `.local/preview-cloudflare/staging-RwfjWC` |
| Production | 2026-10-04 00:03:04 | `a2f87381-b088-4456-9fde-e74e47f8ca4d` | `3c9179da-95fe-4825-915e-1b449bf07b31` | `.local/preview-cloudflare/production-AWEG3i` |

Both versions receive 100% of their environment's traffic, carry the tag `preview-ops-baseline`, expose only a fetch handler and retain only `ASSETS` and `PUBLIC_ORIGIN`. Both artifacts contain 26 manifest entries, including the non-public `_headers` configuration. Their shared Worker SHA-256 is `c2a53426da40f381fcd33391da8aabe54e593a62460f1fefb3db78a7b03a92df`. Manifest SHA-256: staging `eec3c1ce2cffb5f2a3078cac90f1f6db2630633447476dc3e7948e2f3375b1dd`; production `f16f64db0fdbc550e9453d0795ed14be064f6a0837cc02288aca8d886fffcfb1`.

At deployment, the source was HEAD `9dd031c5e6e4774613a470b17cd270c19ef7b6db` plus then-uncommitted preview/UI work and Ops edits. Repository cleanup preserved that published source in local commit `c1fb01e`. Fresh staging and production builds from that checkpoint exactly matched their retained manifests above—all 26 file entries, including Worker, assets and provider configuration. No provider access was used for this reproduction check. Retain the complete published artifacts; do not overwrite them or relabel a later build as this release.

Subsequent local cleanup makes the preview wallet notice inherit shared typography and repairs stale layout/pricing assertions. Those refinements change the next preview bundle and are not deployed. The local adapter fix and explicit pinned Miniflare test dependency do not activate any public capability. OPS must review a fresh tested artifact before any future publication.

Typecheck, all 225 preview unit tests and all 15 packaging tests pass, including both instrumented real `workerd` tests. Those runtime tests prove existing static GET/HEAD requests bypass the user handler; public HTTP checks alone cannot establish billing behavior. A sandboxed rerun initially could not bind its loopback listener (`EPERM`); rerunning with local-listener permission passed without changing tests. Renderer locks and both deployment dry-runs passed.

Corrected public acceptance passed 574 assertions over 59 ordinary requests per host: 1,148 assertions and 118 requests across staging and production, with zero failures. Exact core pages and agent documents, all 16 full-handle SVGs and all 22 static assets—including all 16 font subsets—match their fresh artifacts. CSP, cache/security headers, indexing/canonicals, robots/sitemap, SVG HEAD, static queries, explicit 404s and HTTP-to-HTTPS redirects pass. All six readiness values remain preview-only. No rate-limit flood test was performed.

Two fresh cache-disabled Chrome runs at 390 × 844 passed: staging light and production dark. Each loaded all 16 images and Playpen Sans, had no horizontal overflow or wallet/mint controls, and returned HTTP 200 for all 23 captured same-origin requests. Screenshots were inspected. Artwork GET rendering, version locks and the existing Free-tier CPU caveat remain unchanged; this release does not claim to fix cold-render CPU or eliminate all abuse.

## Local browser inspection

Pass the printed artifact directory to the local adapter:

```sh
node scripts/preview-cloudflare-local.mjs .local/preview-cloudflare/STAGING_ARTIFACT_DIRECTORY 3010
```

The adapter verifies every manifest hash, including `public/_headers`, before listening on loopback. Cloudflare configuration is not served as a public asset. It maps local requests to the artifact's exact public origin only for local viewing. This is not a substitute for the `workerd` test.

## Repository cleanup verification — October 4, 2026

The cleanup preserved authored source and design studies rather than deleting uncommitted work. It fixed local inspection of `_headers`, declared the already-used Miniflare runtime as a pinned direct test dependency, removed the obsolete localhost icon-study backlink, aligned the wallet notice with shared typography, and repaired stale About/layout assertions. Operational ownership is recorded as accepted; no provider settings, deployment, credentials or persistent local runtime were changed. Published artifacts were not deleted or overwritten.

- `npm run typecheck` and `npm run build` pass; all three renderer locks remain unchanged.
- `npm run test:preview`: 225 unit tests and 19 packaging/local-runtime tests pass, including both real `workerd` checks.
- `npm run test:site-icons`: 106 renderer tests and 10 isolated HTTP/raster checks pass.
- Sepolia browser-client regressions: all 137 tests pass with mocked providers and an isolated loopback fixture, not the live chain.
- `npm run test:contract`: 251 offline Solidity tests pass; example manifest validation and all nine role-manifest tests pass.
- Full HTTP-enabled Vitest coverage run: 6,856 tests pass, zero fail, and 553 opt-in persistence/projection tests are skipped because PostgreSQL testing was not enabled. The global coverage command still exits nonzero: statements/lines 84.53% and functions 86.82% fall below the unchanged 93%/97% thresholds; branches are 92.56%. This is not a passing repository-wide coverage gate or database integration certification. No thresholds were lowered, tests excluded or databases started to conceal that limitation.

These are local development checks, not a new public browser audit or release acceptance. Any future publication remains an OPS action requiring the fresh artifact checks above.

## Authentication and publication

Do not load deployment credentials from repository comments, browser session storage or local mint configuration. Once explicitly approved, use Wrangler OAuth with account/user/zone read access and Worker script/route write access. Store the refreshable login in the OS keychain. These permissions apply to the Cloudflare account, not only this repository; use them only for the two Workers above.

Before publication, verify `wrangler whoami` names the intended account. Review the exact fresh artifact and use `wrangler deploy --dry-run --config ARTIFACT_DIRECTORY/wrangler.json`. Publish staging first, with that same config. Custom-domain deployment creates the hostname's routing and managed certificate; do not replace unrelated DNS records if any have appeared since inspection. Stop if deployment requires a billing upgrade or permission beyond the approved scope.

After staging passes the checks below, publish the separate production artifact. Record each deployed version ID, deployment ID, source commit and manifest digest here. Do not describe the resulting website as mint-ready.

## Acceptance and recovery

Check HTTPS on both exact hosts, including an HTTP visit redirecting to HTTPS. Verify the home page, About the work, agent index, explorer, a 16-variation page, all preview images and fonts. Test desktop and mobile for overflow and confirm that navigation and prompt copying work.

`/health/ready` must report `siteLaunchMode: prelaunch` with minting, wallet connections and RPC disabled. Staging must return noindex and deny crawling in robots. Production canonical links and sitemap must use `https://signatures.gallery`. Browser requests must stay on the site's origin, apart from an explicitly followed external link. Confirm that no mint or wallet action is possible.

Before promoting production, inspect staging CPU usage and invocation errors for a full 15-character handle across all 16 previews. The [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) include a 10 ms CPU budget per HTTP request. Local runtime and layout tests do not prove hosted CPU-budget compliance. If actual requests exceed the budget, pause promotion to evaluate optimization or obtain an explicit hosting decision; do not upgrade billing automatically. The initial production release is a user-approved Free-tier trial, not a claim that the CPU concern has been fixed.

The initial hosted acceptance sample showed P50 1.682 ms, P90 12.806 ms and P99 22.641 ms across 46 invocations, with zero invocation errors and zero CPU-limit terminations. After redeployment and a fresh 16-preview batch, the dashboard filtered to version `eab49592` showed P50 2.105 ms, P90 5.918 ms and P99/P999 11.447 ms. These are aggregate dashboard quantiles, not route-specific maxima. Successful HTTP responses do not establish budget compliance: Cloudflare allows occasional overruns but may terminate consistently over-budget work. The user subsequently chose to launch on Free for now; this explicit decision cleared the promotion hold without changing billing or the renderer. Free-tier CPU and daily request limits remain a production reliability caveat, not a reason to claim every overrun is a failed request.

Read-only local profiling of the exact initial bundle found fast warm rendering but cold import/render overhead. Finite hash lookup experiments did not reliably reduce the cold total below the budget; no experimental renderer transformation was applied. Node process CPU is diagnostic evidence, not Cloudflare billing CPU. Wrangler tail failed with connection resets, so the dashboard is the available hosted CPU evidence; persistent logs/traces have not been enabled.

Public checks through the machine's configured proxy sometimes returned connection resets. Direct public HTTPS, with certificate verification enabled and no DNS override, succeeded. Treat the proxy failure separately from an actual site outage.

If a deployment fails acceptance, keep minting disabled. Roll back the affected Worker to its last verified version using Cloudflare's deployment history, without changing the other environment. For the first rollout, when no previous verified version exists, remove only that new custom-domain binding or correct and redeploy the preview package. Removing a binding takes that hostname offline; do not delete the zone or unrelated DNS records.

Retain the deployed artifact and its manifest for reproducible recovery. A local prelaunch package cannot restore a chain or database. Free-mint policy, paid-mint configuration and backend activation require a separate reviewed rollout.

## Cloudflare references

- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/#login)
- [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Deployment rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
