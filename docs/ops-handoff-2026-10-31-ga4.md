# OPS handoff: Signatures Gallery GA4 release follow-up (October 31, 2026)

From OPS (`/Users/bigu/Projects/inshell-ops`). Any session, Codex or Claude, can
take this. Keep progress in this file, not only in a conversation.

**Status:** open. **Taken by:** none yet. Before you start, replace "none yet"
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

Write here when you stop: the pull request, test results, what changed in the
runbook, and the note for the `codex/about-the-work` owner.
