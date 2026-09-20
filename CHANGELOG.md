# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]

### Fixed

- **Out of date** rows keep the branch pill and check summary separate on desktop, with wrapping actions on their own line. Responsive regression checks cover both themes and mobile widths.

- **Out of date** now invalidates cached comparisons when the live base branch advances. GitHub's PR `baseRefOid` can remain on an older commit, hiding newly stale branches for six hours. Detection uses `baseRef.target.oid` instead and retries incomplete comparisons on the next scan instead of caching them as zero.

- The repo owner failed WCAG AA in the light theme. `--muted` measures 4.26:1 on a row and 4.01:1 on a tinted conflict row, and 4.48:1 against the hover surface in dark -- so the label shipped in the previous entry was below the bar on three surfaces. It has its own token now, solved against every background a row actually uses.
- Two accessibility assertions were passing without measuring anything. axe cannot resolve a background that sits over the row's `::before` accent bar, so it returns those nodes as `incomplete` rather than as violations -- and at Playwright's default 1280px viewport it returns *every* node in `#content` that way. Both axe tests read only `violations`, so both were vacuous at the width they ran at. They now pin an explicit viewport, count `incomplete` as a finding, and leave colour to the checks that compute it from the token values against every real row background.

### Added

- **Repository colours.** Every row's repo name now carries a colour of its own, so a board drawn from nine repos can be scanned by shape rather than read word by word. The owner is de-emphasised -- it repeats on every row and is rarely the part you are looking for -- and the repo segment takes the colour. A repo keeps its colour for good: the assignment is a small registry in `localStorage`, which hands out a slot nothing else is using rather than hashing the name, because with nine repos over twelve slots a hash collides more often than not. The palette deliberately skips the three hue bands the status colours own -- red, amber and green -- so a repo name can never be misread as an alarm, and every value clears 4.5:1 on both the row and the hover surface in both themes.

### Fixed

- **Out of date** measured the wrong thing. The lane read `aheadBy` from the base-to-head comparison, which is how many commits the PR *adds*, not how far it has fallen behind. The effect was that every PR with any commits of its own was flagged as stale, every genuinely stale PR was missed, and the pill's number was the PR's own commit count. `Ref.compare(headRef:)` describes the head relative to the base exactly as `/compare/<base>...<head>` does, so the field is `behindBy`; measured against both the REST endpoint and `git rev-list --count`. On the twelve PRs open here that is the difference between flagging ten and flagging the four that are actually behind.

### Added

- **Out of date**: a new PR lane for branches that have fallen behind their base, with an `Update branch` button that merges the base in without leaving the dashboard. An open PR whose head is behind its base and has no conflict leaves whichever CI lane it was in and appears here instead, because being behind is what is actually stopping it from merging; a conflicting PR still belongs to Conflicts, since GitHub refuses an update on one. Each row states how far behind it is and against which branch, keeps its `Merge`, `Close` and `Rerun failed` actions, and announces itself once when the update is the *only* thing left blocking it. Detection is cached on the base and head commits, so a scan that finds nothing moved costs no extra request.

- Cancelled runs now arrive pre-dismissed, in both **Failing CI** and **Failed CD**. A cancelled run offers no retry worth queueing and no failure to read — most are the concurrency group cancelling the previous commit's run — so it leaves the actionable list and its tile while staying reachable behind the dismissed bar's "Show", labelled `Auto-dismissed`. User dismissals are untouched, so `Restore all` never drags them back. Whether a merged change actually reached production is answered by the pipeline-trace lane, which reads the trace's own CD evidence rather than this row list. Set `AUTO_DISMISS_CANCELLED_RUNS=0` to opt out.
- Deep CI/CD queues can now trigger an opt-in, server-managed cleanup that closes open Dependabot PRs and cancels active Dependabot workflow runs. Set `DEPENDABOT_QUEUE_THRESHOLD` to a positive queued-run threshold and optionally restrict scope with `DEPENDABOT_QUEUE_OWNERS`; the policy is disabled by default, paginated, quota-aware, and cooldown-guarded.
- The footer rate-limit chip now tracks each GitHub App installation as an independent bucket. The headline number is the *tightest* bucket (lowest remaining-to-limit ratio) across all observed installations and resources — the one that would throttle first — and a `+N bucket(s)` suffix indicates additional buckets exist. Hover the chip for the full per-installation breakdown (account, used/limit, reset time) and the total observed capacity. PAT mode shows a single bucket as before.
- GitHub App authentication is now supported alongside the existing PAT path. When `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` are both set, the server signs a short-lived JWT, discovers installations, and mints per-installation access tokens that route requests by owner. PAT auth remains the default when those variables are absent. Setup, permission scoping, private-key handling, and rate-limit trade-offs are documented in `docs/github-app-setup.md`.
- GitHub REST GET requests now reuse ETag-based conditional caching: subsequent scans send `If-None-Match` and a 304 response is served from memory without consuming the primary rate limit. Warm dashboard refreshes now spend close to zero quota points where they previously spent dozens.
- Server-managed auto merge now monitors eligible passing PRs in the selected scope, keeps the countdown active without relying on the browser tab, and exposes `/api/auto-merge`.
- No-CI pull requests now appear in a dedicated view when they are non-draft, conflict-free, and reported as mergeable by GitHub.
- Pull requests can be closed from the dashboard through `POST /api/pull-request/close`.
- CI and CD failure rows and notifications now include the failing check, job, or workflow reason when GitHub reports one.
- Browser and in-app release notifications include more detail for completed CI/CD work.
- Security and release-readiness checks now include CI, CodeQL, dependency review, Scorecard, package verification, issue templates, PR templates, CODEOWNERS, and community documentation.
- Fuzz coverage was added for hardening-sensitive server behavior.
- Community documentation now includes contributor orientation and support boundaries for open source users.

### Changed

- Auto-merge waits are now flagged and notified only after one hour, instead of after five minutes.
- Running CI and CD workflows are now flagged as long-running only after they exceed four hours.
- Merged PRs are no longer flagged for a missing production CD run while post-merge CI is still queued or running on the base branch, and the "no matching CD run" window is now four hours from merge instead of 15 minutes. Slow pipelines are no longer reported as failures before CD has had a chance to start.
- Failed CD now lists only CD workflow runs that are still failing. A failure that has already been superseded by a newer successful run on the same workflow is no longer surfaced as a current problem; the run remains visible in Finished CD as a historical FAILURE row. The view title now reads "CD workflows still failing".
- Auto merge now targets only passing PRs with completed checks, while manually mergeable no-CI PRs remain available for explicit user action.
- Auto merge countdown was shortened from 30 seconds to 15 seconds.
- PR searches exclude archived repositories.
- The dashboard UI was tightened for accessibility and operational clarity by simplifying unused controls and improving segmented-control semantics.
- Repository metadata, package metadata, README, support, security, contributing, maintainer, license, and code of conduct documentation were prepared for public open source release.
- Changelog maintenance is now part of the contribution workflow, and this changelog has been backfilled with the project changes made so far.
- Refresh behavior is now driven by GitHub API quota state: low quota pauses refresh, disables the manual refresh button, and waits for the reset window.

### Fixed

- Failing CI now includes recent failed non-CD GitHub Actions runs, not only failed open-PR check rollups. This catches push-to-main CI failures such as merge-commit regressions and keeps them visible until a newer successful run in the same workflow and branch resolves them.
- Failed CD now surfaces every workflow run that failed within the 3-day window, including failures that were superseded by a newer completed run. The previous "latest run only" logic silently hid failures whenever a follow-up redeploy succeeded or was skipped, while Finished CD still listed them as `FAILURE` — making the two views disagree on whether any deploys had failed.
- Each Failed CD row now indicates whether it is still failing or has been resolved by a newer successful run, and the Failed CD scoreboard chip distinguishes "N still failing" from "all resolved".
- Auto merge button now updates as soon as the server completes the merge, instead of staying stuck on "Merging" until the next periodic refresh.
- Auto merge button is disabled while in the "Merging" state so a user cannot fire a duplicate merge request that races the server-side auto-merge scan.
- Merge requests are rechecked server-side before merging and reject drafts, conflicts, failing checks, running checks, and no-CI PRs that GitHub does not currently report as mergeable.
- Successful merges now delete the PR head branch when GitHub allows it.
- Scorecard and code scanning workflows were corrected and gated appropriately for private repository state.
- Dashboard security headers now apply to API and static responses.
- CI/CD notification snapshots now account for conflicts and no-CI PRs so completion alerts do not miss visible PR states.
- Successful merge, close, and auto-merge follow-up actions no longer trigger an immediate status rescan while the dashboard is waiting for its scheduled refresh clock.

## [1.0.0] - 2026-05-13

- Initial local GitHub operations dashboard with PR, CI, CD, deployment, runner, notification, and guarded merge workflows.
- Direct GitHub REST and GraphQL integration using `GITHUB_TOKEN`, `GH_TOKEN`, or local GitHub CLI auth.
- Owner, owned-repository, and authored-PR dashboard scopes.
- PR grouping for passing, failing, running, and merge-conflict states.
- Optional CD/deploy/release/publish workflow audit, recent CD completion tracking, failed CD tracking, and running deployment visibility.
- Busy self-hosted runner visibility.
- GitHub API quota tracking with adaptive refresh recommendations.
- Browser notifications, service worker support, and an in-app notification inbox.
- Guarded manual merge support for passing PRs.
