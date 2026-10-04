# Site Ops — first baseline

Scope: the public preview-only sites at `signatures.gallery` and `staging.signatures.gallery`. Protect availability without treating legitimate visitors or agents as abuse. Use Cloudflare's controls and notifications; do not build a second WAF, email sender, monitoring dashboard or on-call service.

This baseline does not activate minting, wallets, the chain relay, RPC, Grok, a database or paid hosting. Operational failures go to operators, not to visitors who are simply viewing previews.

## Ownership handoff

Central OPS owns Signatures Gallery operations: hosting/provider settings, monitoring and alerts, incident triage, quota/expiry tracking, deployments, recovery verification and operator reporting. Its canonical repository is `/Users/bigu/Projects/inshell-ops`, coordinated in chat `019eca52-9896-7190-ae8d-38d647291242`. This Signatures Gallery chat retains development: product/design, code, tests, security/performance fixes, build artifacts and technical release instructions. Necessary application fixes remain development work; provider rollout is coordinated by OPS.

Central OPS accepted the completed handback on October 4, 2026 and recorded ownership in its `AGENTS.md` and `docs/ops-portfolio-ownership-2026-10-04.md`. This document preserves the handback baseline; subsequent operational records belong there. Further OPS implementation remains paused by the operator. This handoff authorizes no provider action, account migration, credential sharing, new automation or change to production, billing, credential or signing approval boundaries. Keep the existing Agent Art accounts and `this.agent.art@gmail.com` alert recipient separate. Do not independently resume the unfinished Cloudflare email follow-through here. OPS accepted the outstanding Cloudflare email-receipt verification and quota/expiry inventory gaps. UptimeRobot's four first checks and both simulated DOWN/UP email receipts are verified; no repeat tests are needed. Historical monitor cleanup remains optional and unauthorized.

## Current state — October 4, 2026 (Asia/Shanghai)

| Control | State | Owner / mechanism |
| --- | --- | --- |
| Excessive dynamic bursts | Active | Cloudflare WAF rate limiting |
| HTTP → HTTPS, including direct static assets | Active | Cloudflare Always Use HTTPS |
| Static files bypass user Worker execution | Live on both hosts; deployment recorded in the hosting runbook | Cloudflare Workers Static Assets |
| SVG HEAD avoids artwork rendering | Live on both hosts; deployment recorded in the hosting runbook | Small application change |
| Production server-failure email | Saved and Enabled to `this.agent.art@gmail.com`; native test requested, human receipt pending | Cloudflare Custom Alerts |
| HTTP DDoS mitigation email | Saved and Enabled to `this.agent.art@gmail.com`; native test requested, human receipt pending | Cloudflare built-in notification |
| Independent external uptime checks | All four first checks verified Up; user confirmed receipt of both DOWN and UP test emails | UptimeRobot Free, five-minute keyword checks; 4 of 50 monitors used |

All Ops alerts must use `this.agent.art@gmail.com`, as explicitly confirmed by the user. Email is outbound notification delivery only: no inbox connection, mail-reading permission, SMTP password or custom email relay is needed. Cloudflare policies already use this address; their separate test receipts still require human confirmation. The user completed sign-in to the existing Agent Art UptimeRobot account, which showed 0 of 50 monitors before these four additions and now uses 4 of 50. Its approved email contact was inspected as active with UP and DOWN events enabled and attached to all four monitors. All four first checks are verified Up; on October 4 the user confirmed that both simulated DOWN and UP test emails arrived. UptimeRobot test email delivery is therefore verified. No account creation, billing or access changes were made. Initial unattached entries in the separate `3kg3kg@gmail.com` account remain historical and untouched; do not enable alerts there or change that account's login email.

## Abuse protection

The zone's one Free-tier rate-limiting rule is:

- Name: `Signatures Gallery · excessive dynamic bursts`.
- Rule ID: `ca2ce5653dd84d0c868a9af30601b85a`.
- Expression: `(not http.request.uri.path in {<22 exact published asset paths>} and not cf.client.bot)`. The dashboard stores the actual path set, not this placeholder.
- Characteristic: source IP.
- Threshold: 240 matching requests in 10 seconds.
- Action: block for 10 seconds; Cloudflare's default response is HTTP 429.

The rule is zone-wide, covering staging and production. Only the 22 exact packaged static paths and Cloudflare-verified bots are excluded. Nonexistent `/assets/*` requests remain counted because they can invoke the fallback Worker. Ordinary agents are not banned: they follow the same generous burst limit as other unverified clients. Do not enable blanket Bot Fight Mode, a CAPTCHA on every preview, or a daily per-person allowance.

The initial prefix exemption was narrowed after review exposed that missing-file bypass. For each release, derive the exempt set from `public/` manifest entries, excluding `public/_headers`; use the union of assets actually published on the two hosts during promotion, then remove obsolete paths. Never leave a removed asset path exempt indefinitely, and never broaden the set to the whole prefix. This native rule requires release maintenance; it is not automatically synchronized by application code.

This is an initial service-specific threshold, not a Cloudflare recommendation or a guarantee against all abuse. An IP can represent many people behind a shared network. Cloudflare's distributed counters are not an exact global quota. Distributed and low-and-slow traffic can remain below this threshold. The native Free-tier rule has been saved and inspected, but no production flood test has been performed. [Cloudflare rate-limiting behavior and plan limits](https://developers.cloudflare.com/waf/rate-limiting-rules/).

If legitimate shared-network traffic is affected, inspect Security Events for this exact rule, paths and timing before changing its threshold. Change only this rule, record the reason and recheck normal browsing. Do not disable unrelated protections or block all automation. A short native cooldown expires automatically; no application recovery job is needed.

## Application gaps addressed

Cloudflare cannot infer which repository files should bypass application execution or that an SVG HEAD request need not render artwork. The changes are confined to the preview packager and handler:

1. Existing static files use assets-first routing, with HTML and not-found fallbacks disabled. `_headers` specifies exact per-file security, cache and staging noindex headers. The file is configuration, not a public endpoint. Query strings on a static asset safely return the same packaged bytes.
2. A valid generated-preview HEAD request returns the usual status and headers without generating its unused image body. GET artwork and locked renderers are unchanged. Dynamic path/query validation remains enforced.

Public static routing does not run the Worker's authority/query/HTTP middleware. Exact custom-domain routing supplies the host boundary; the zone's Always Use HTTPS setting supplies redirects for direct assets. Do not later add authenticated content to this public asset directory.

[Static asset delivery bypasses billed Worker execution when the user Worker is not invoked](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). This reduces avoidable invocations; it does not make generated pages and images unlimited or eliminate the Free-tier CPU limit. No custom cache service or app-side rate-limit database was added.

## Cloudflare email policies — enabled, delivery pending

Keep the initial set small:

| Signal | Policy | Response |
| --- | --- | --- |
| Repeated production HTTP 5xx | Native custom threshold alert, production hostname only; query below | Check public readiness and a preview, then inspect Worker errors and the latest deployment |
| Cloudflare mitigates an HTTP DDoS attack | Native HTTP DDoS Attack Alert | Inspect mitigation and visitor impact; do not automatically tighten rules |
| An ordinary 429, 400, 404, or CPU percentile spike without failures | No email incident | Investigate only if correlated with a genuine availability problem |
| Fair demand approaches capacity | Human capacity decision, not an automatic ban or billing action | Review request/error/CPU trends and consider a paid upgrade with explicit approval |

The production server-failure policy `01f7faed2c2e4b82a1d9991656c50313` is saved and Enabled to `this.agent.art@gmail.com`: threshold `>= 3`, five-minute evaluation window, Automatic time range, execution every five minutes, and six hours between repeat notifications while active. These are starting values to tune from real incidents, not a promise of exactly three unsampled failures. Cloudflare's dashboard describes the evaluation window as averaging; query data can be sampled. Its saved query is:

```sql
SELECT COUNT(*) AS "value"
FROM "events"."httpRequests"
WHERE "accountTag" = 'a54e5847cc16e612aa3ad45a5dadb563'
  AND "zoneTag" = '0531405cf3b989a9d187c7383ad846a3'
  AND "clientRequestHttpHost" = 'signatures.gallery'
  AND "edgeResponseStatus" >= 500
```

The SQL API applies sample weights itself: do not manually sum `sampleInterval` and double-weight the count. Automatic mode supplies the query time bounds. Cloudflare Custom Alerts are currently Beta; if that facility proves unreliable, use the independent monitor for customer-facing availability rather than writing a notification bridge. The HTTP DDoS policy `17e9937902f044579d6f2345abef8c23` is also saved and Enabled to `this.agent.art@gmail.com`. It is account-wide because the native alert has no per-zone filter, so its emails may cover another zone in this account. [Native alert capabilities and limitations](https://developers.cloudflare.com/notifications/notification-available/).

The native Test and Confirm actions were invoked once for each Cloudflare policy. This records a test request only: no delivery confirmation or inbox receipt was observed. Human confirmation of both messages, including spam placement, remains pending. Do not repeat tests merely while waiting for receipt, and do not generate intentional public failures or an attack to test delivery. Successful policy creation or a test request does not prove email delivery.

## Independent availability — Agent Art checks and test email delivery verified

A traffic-derived Cloudflare alert cannot prove reachability during zero traffic, a DNS failure, or a failure of Cloudflare's own monitoring path. The 5xx policy also does not detect an outage returning a different status; an intentional 429 cooldown must not become a generic incident email. The verified UptimeRobot setup addresses this independent-probe gap. Use a mature uptime service with email alerts, not a scheduled Codex chat or a homemade polling/email process.

The user chose UptimeRobot and confirmed the existing Agent Art account and `this.agent.art@gmail.com` as the sole Ops recipient. Sign-in is complete; that account showed 0 of 50 monitors before these four additions, and its email contact was active with UP and DOWN events enabled. Free supports the required five-minute HTTP and keyword checks and permits commercial use. API/JSON assertions were gated behind a paid plan in the initial account, so the baseline uses keyword monitors. No account creation, billing, subscription, trial, card entry, account-email or access change occurred. [Free-plan eligibility and core features](https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan), [keyword monitoring](https://uptimerobot.com/keyword-monitoring/).

All four monitors below were created in the existing Agent Art account. Each creation form was inspected with the exact keyword, incident when the keyword does not exist, case-sensitive matching checked, five-minute checks, default GET body fetching, the `this.agent.art@gmail.com` contact selected, and no delay / no repeat. Ordinary public HTTPS GET checks passed for all four targets with HTTP 200 and the exact expected content on October 4. Those public checks verify the targets, not UptimeRobot's first-check results or email delivery:

| Monitor | Public URL | Exact expected keyword | Creation state |
| --- | --- | --- | --- |
| Production homepage | `https://signatures.gallery/` | `<section class="home-grid">` | ID `804165864`; Up, five-minute interval, first check verified; Agent Art contact attached |
| Production preview readiness | `https://signatures.gallery/health/ready` | Entire compact readiness JSON below | ID `804165852`; Up, five-minute interval, first check verified; Agent Art contact attached |
| Production generated SVG | `https://signatures.gallery/preview/Alice_Bob_Key/INTJ.svg?renderer=sg-renderer-2.0.0` | `<path d="M76.97,192.25L69.29,186.22L63.19,182.24` | ID `804165869`; Up, five-minute interval, first check verified; Agent Art contact attached |
| Staging preview readiness | `https://staging.signatures.gallery/health/ready` | Same entire compact readiness JSON below | ID `804165861`; Up, five-minute interval, first check verified; Agent Art contact attached |

The final UptimeRobot monitor list was inspected: all four monitors were Up with five-minute intervals and 100% uptime over their short initial history; there were 0 Down and 0 Paused monitors, using 4 of 50 slots. Saved details and approved contacts were inspected. This verifies the first monitor checks, not long-term reliability or email delivery.

Historical initial-account record: the separate `3kg3kg@gmail.com` Free account showed 3 of 50 monitors before the earlier additions. Production readiness `804165620`, staging readiness `804165627` and homepage `804165632` were last inspected as Preparing without alert contacts. Its SVG creation displayed `Monitor created!` before sign-in was lost, but that entry's ID and saved detail remain unverified. These entries remain unattached and untouched; they are not Agent Art monitors, must not receive alerts, and must not be deleted or otherwise changed without separate authorization.

Readiness keyword, entered as one line without the trailing newline:

```json
{"live":true,"frontendOnly":true,"siteLaunchMode":"prelaunch","mintingEnabled":false,"walletConnectionEnabled":false,"rpcEnabled":false}
```

The full 136-character body checks all six required preview-only values in one keyword. Both hosts serialize this fixed object in the displayed order and return `Cache-Control: no-store`. The homepage marker identifies the actual home layout. The SVG geometry prefix checks nonempty generated artwork, rather than only an SVG wrapper; HEAD is unsuitable because the worker deliberately omits rendering for HEAD. The version-pinned SVG response permits a 300-second cache lifetime.

Use five-minute intervals, a 30-second request timeout, the default single region, and native failure confirmation. UptimeRobot confirms an initial failure with up to three sequential re-checks in the same region, roughly 10–20 seconds apart depending on the failure; this is not a multi-region vote. A paid plan is not needed for these checks. [Native confirmation and region behavior](https://help.uptimerobot.com/en/articles/11358522-understanding-uptimerobot-locations-and-multi-location-feature).

The existing Agent Art account's approved `this.agent.art@gmail.com` email contact is selected for all four checks, with UP and DOWN events enabled and no delay / no repeat. No other notification contacts, integrations, SMS or voice channels were added for these checks. Free does not provide configurable postponement or recurrence. Each user has one personal email channel, usually the registration email, while additional email contacts require paid notify-only seats; using the Agent Art account avoids redirecting the separate account. Delivery of both simulated outage and recovery emails is verified by the user's receipt confirmation. [Email-contact limits](https://help.uptimerobot.com/en/articles/11360953-uptimerobot-personal-notification-channels-setup-guide), [paid-only delay and recurrence](https://help.uptimerobot.com/en/articles/11361289-recurring-postponed-notifications-in-uptimerobot).

The native Test Notification → Send test notifications action was invoked once on the SVG monitor `804165869`, with only the approved Agent Art email attached. UptimeRobot displayed `Test notification sent`. On October 4, 2026 (Asia/Shanghai), the user confirmed that both simulated DOWN and UP emails arrived at the approved recipient. This verifies the test delivery path, not a real outage drill or future delivery guarantee. No inbox was accessed and no repeat test is needed. Cloudflare's separate test receipts remain unconfirmed. [Notification test procedure](https://help.uptimerobot.com/en/articles/11602913-how-to-test-notifications-in-uptimerobot-quick-guide).

Avoid frequent full 16-image gallery probes. TLS/DNS failures must remain failures—never bypass certificates. Deployment smoke checks still verify all six readiness values, image bytes and font assets; uptime checks do not replace release acceptance.

## Release, recovery and operator procedure

The [Cloudflare preview hosting runbook](cloudflare-preview-hosting.md) contains exact artifacts, manifests, version IDs, tests and rollback steps. Stage first, run bounded ordinary public checks and inspect a real mobile browser, then promote the exact production artifact. Keep security headers, staging noindex and the six preview-only readiness values intact. Retain the previous verified version and artifact.

When notified:

1. Verify the affected public URL and a generated preview over ordinary HTTPS. Separate a local proxy failure from a site failure.
2. Inspect Worker invocation failures, HTTP 5xx, the deployment version and Cloudflare status. A high CPU quantile alone is not proof of an outage; look for actual exceptions/resource-limit terminations and failed responses.
3. For abuse, inspect Security Events before altering limits. For a release regression, roll back only the affected Worker to its previous verified version. For fair growth, propose capacity changes; do not automatically bill or ration visitors.
4. Confirm recovery, record the cause, time, action and follow-up. Do not expose internal RPC/network warnings to people merely viewing the public relay-backed site.

No persistent request logs, new credentials, email infrastructure, database, queue, paid add-on, automatic upgrade or recurring Codex launch monitor has been enabled by this baseline. Minting Ops requires a separate rollout when the backend and contracts are opened.
