# OPS handoff: Signatures Gallery GA4 release follow-up (October 31, 2026)

From OPS (`/Users/bigu/Projects/inshell-ops`). Any session, Codex or Claude, can
take this. Keep progress in this file, not only in a conversation.

**Status:** done (see Outcome). **Taken by:** Claude Code (Opus 5.5), worktree
`ga4-followup-71c3dc`, branch `claude/ga4-followup-71c3dc`, October 31, 2026,
10:23 China. Before you start, replace "none yet"
with your agent and session and the China time; when you stop, write the
outcome at the end of this file.

## What already happened (do not redo)

- Operator decision, October 30: reverse the October 3 no-analytics stance and
  measure visitors with optional consent-first GA4. OPS built and released it.
- Source: commit `7646fbd` on `origin/main` `37d2619`, merged as
  [PR #3](https://github.com/agent-art-work/Agent-Art-signatures.gallery/pull/3)
  (merge commit `1b29335`) on October 31, 08:38 China. All 16 checks passed.
- Changed:
  - `src/preview/analytics.ts`, `analyticsUi.ts`, `analyticsMarkup.ts`:
    measurement ID `G-QBCNPY7QK1`; analytics runs only on
    `https://signatures.gallery`.
  - `src/preview/analytics.test.ts`.
  - `src/preview/worker.ts`: `previewContentSecurityPolicy`; the production CSP
    adds only Google's hosts, and staging keeps `connect-src 'none'`.
  - `src/preview/worker.test.ts`, `src/preview/client.ts`.
  - `src/openMint/pages.ts`: the layout renders the notice and dialog.
  - `src/brand/footer.ts`: `siteFooter` gains an `extra` parameter for the
    "Analytics choices" button.
  - `scripts/build-preview-cloudflare.mjs`,
    `contracts/tools/preview-cloudflare.node-test.mjs`.
  - `docs/cloudflare-preview-hosting.md`: new "Optional analytics" paragraph
    near line 32.
- Staging: `signatures-gallery-staging` version `437d0660` (rollback `e0a515ad`).
- Production: `signatures-gallery` version `7b5a8084` at 100% since about 07:35
  China (rollback `6f5379cd`, tag `preview-maintenance-9818`). Both run the same
  Worker build (SHA-256 `9a0120dd…`).
- Build artifacts, kept in the main checkout's `.local/preview-cloudflare/`
  (do not delete; they are the rollback builds):
  - `staging-3ET1kP`: an earlier upload (`23764a03`), since replaced.
  - `staging-rvRd1V`: the staging build.
  - `production-RjU8Qr`: the production build.
- OPS evidence: `/Users/bigu/Projects/inshell-ops/docs/ga4-rollout-pulse-gallery-2026-10-30.md`
  and `docs/evidence/ops-progress-2026-10-08/round-2-coverage-2026-10-11/ga4-pulse-gallery-release-2026-10-31.json`
  in that repository.

## To do

Work in your own git worktree on a branch from `origin/main`, and open a pull
request. Leave the shared checkout at `/Users/bigu/Projects/Agent-Art-signatures.gallery`
alone. It is on `codex/about-the-work`, with uncommitted edits to
`docs/cloudflare-preview-hosting.md` and `docs/site-ops.md` that belong to
other work.

1. Add this release to the runbook's deployment records in
   `docs/cloudflare-preview-hosting.md`, for staging and production:
   - version IDs and UTC deployment times;
   - deployment IDs, read with `npx wrangler deployments list --name <worker>`;
   - artifacts and their manifest digests.
2. The October 3–4 statements that there was "no analytics beacon markup and
   no external requests" are now true only before consent and on staging. The
   new paragraph says so; check the rest of that runbook and `docs/site-ops.md`
   for wording that now claims more.
3. Run the unit tests, the packaging tests and the build on your branch.
4. In the Outcome below, note this for whoever owns the uncommitted
   `codex/about-the-work` edits: bring `origin/main` (and your merged PR) into
   that branch before committing. Expect a conflict in
   `docs/cloudflare-preview-hosting.md`, and keep both sides.

## Boundaries

- No analytics event may carry handle, MBTI choice, wallet or mint data. Page
  categories stay the closed list (Home, About, Explore, MBTI galleries,
  Previews).
- The deploy used the retained Gallery Wrangler sign-in; no new credential was
  created.
- This handoff authorizes no deployment, provider or Cloudflare change.

## Outcome

Done October 31, 2026, 10:35 China, by Claude Code (Opus 5.5) on branch
`claude/ga4-followup-71c3dc` from `origin/main` `1b29335`. Pull request:
PR_LINK_PLACEHOLDER.

**Deployment records (item 1).** `docs/cloudflare-preview-hosting.md` has a new
section, "GA4 release — October 31, 2026". Deployment IDs were read with
`npx wrangler deployments list` and `deployments status` at 10:26 China, using
the retained Gallery sign-in, read-only:

| Worker | Version | Deployment | UTC | Artifact | Manifest SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `signatures-gallery-staging` | `437d0660` | `42f83710` | 2026-10-30 22:48:25 | `staging-rvRd1V` | `54328e26…0cb7` |
| `signatures-gallery` | `7b5a8084` | `4d0aa35e` | 2026-10-30 23:31:31 | `production-RjU8Qr` | `0ad76911…2e7b` |
| staging, replaced | `23764a03` | `efb566bf` | 2026-10-30 22:45:12 | `staging-3ET1kP` | `8b066221…8d90` |

Both live versions are at 100%. The section also records the rollback targets
(staging `e0a515ad` / deployment `b2c30b1a`, production `6f5379cd` / deployment
`ed369296`, tag `preview-maintenance-9818`) and OPS's acceptance checks.
Production's deployment record says 07:31:31 China, not "about 07:35".

Fresh `--output-dir` builds from `1b29335` reproduce both deployed artifacts
exactly: same manifest digests, all 27 files byte-identical. `staging-3ET1kP`
differs from `staging-rvRd1V` only in `public/assets/preview.css`. The public
file paths match the October 4 package, so the rate-limit exempt path set in
`docs/site-ops.md` needs no change.

**Wording (item 2).** In the runbook:

- The October 3 "no analytics beacon markup and no external requests"
  statement now says it holds on staging always and on production only until
  a visitor allows analytics.
- The standing acceptance rule "browser requests must stay on the site's
  origin" now allows Google's hosts on production after **Allow analytics**
  only, and requires nothing to reach Google before consent, on staging or in
  automated browsers.
- Three present-tense claims that the October 3–4 versions are the current
  rollback or carry 100% of traffic are now past tense and point to the GA4
  section.

`docs/site-ops.md` makes no analytics or external-request claim; it is
unchanged. The October 5 maintenance release (`9818b00`) is recorded in OPS but
was missing from this runbook; it is now named as the rollback target, without
a full record of its own.

**Tests (item 3), on this branch.** `npm run typecheck` passes. Full `vitest
run`: 6,813 passed, 625 skipped (opt-in PostgreSQL/HTTP suites), 0 failed.
`npm run test:preview`: 253 preview unit tests and 77 packaging/real-`workerd`
tests pass. `npm run build` passes. Both `preview:build` targets pass with
Worker SHA-256 `9a0120dd…dfd7fb3`.

No deployment, provider, Cloudflare or GA4 change was made.

**Note for the owner of the uncommitted `codex/about-the-work` edits
(item 4).** That branch's working tree in
`/Users/bigu/Projects/Agent-Art-signatures.gallery` has uncommitted edits to
`docs/cloudflare-preview-hosting.md` and `docs/site-ops.md`. Before you commit,
bring in `origin/main`, including PR #3 (GA4) and this pull request once it is
merged. Git will not merge over uncommitted edits to the same files, so set
yours aside first in a local work-in-progress commit (or a tagged stash), then
merge. Expect a conflict in `docs/cloudflare-preview-hosting.md`: this PR edits
the staging, production and First Ops release record paragraphs, the
acceptance rule, and adds the "GA4 release" section after "First Ops release".
Keep both sides. `docs/site-ops.md` is untouched here.
