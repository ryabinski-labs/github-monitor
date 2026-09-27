---
spec: spec-clarifier/v1
feature: installation-repo-listing-cache
title: Installation repo listing survives the shared ETag slot
status: complete
prompt: inline
prompt_sha256: e4935a88c1798c08ea7476f067784291d4b45b2973c64e70e5a996cd21956e74
created: 2026-09-27
---

# PRD: Installation repo listing survives the shared ETag slot

## 0. Source prompt

> this is running https://github.com/ryabinski-labs/Sendant/actions/runs/36333230167 [Image #1] we are not showing it, what's broken? /spec-clarifier

## 1. Problem

The user watched `iOS CD · Archive and TestFlight` run 36333230167 in `ryabinski-labs/Sendant` (workflow_dispatch on `main`, started 2026-09-27 16:26 UTC) and the dashboard did not show it: Running CD read 0 and Repos read 10 at 16:36 UTC, with accounts `cigan1` and `ryabinski-labs` selected. Two minutes later the same query returned Running CD 1 over 38 repos.

Root cause, from repo: the conditional-request cache `etagCache` stores entries under the request URL alone (`server.js:814`). `GET /installation/repositories` has the same URL for every GitHub App installation, so all four installations (`GipsyChef`, `cigan1`, `siftfy`, `ryabinski-labs`) share one slot. When one installation's 200 overwrites the slot while another installation's request is in flight, the second request's 304 returns the first installation's body (`takeCachedConditionalResponse`, `server.js:788`). `loadOwnerRepos` then filters that body by owner login (`server.js:2372`) and returns an empty list as a success: no warning, no log line, cached for `OWNER_REPOS_CACHE_TTL_MS` (5 minutes), and written over the last-known list that PR #147 falls back to. Every repo of that owner without an open PR drops out of the scan, including its running CD.

Evidence: the race was reproduced with the exported helpers (`storeConditionalResponse`, `applyConditionalHeaders`, `takeCachedConditionalResponse`): the `ryabinski-labs` request received the `cigan1` body and kept 0 repos. `.cache/etag-cache.json` saved at 16:42:58 UTC holds exactly one `/installation/repositories?per_page=100&page=1` entry, containing 76 `ryabinski-labs` repos.

## 2. Target user

- **Primary:** the operator running the local dashboard (`server.js` under the `com.ryabinski.github-monitor` LaunchAgent) with GitHub App auth across more than one installation. Today that is four installations: `GipsyChef`, `cigan1`, `siftfy`, `ryabinski-labs`.
- **Secondary:** PAT-mode operators. The key carries `pat` for them, and their behavior does not change beyond the new key shape.
- **Explicitly not for:** consumers of `/api/queue`. The fix reaches them too, but this spec makes no claims about queue depth.
- **Job-to-be-done:** When a CD workflow is running in any repo of a selected account, I want the Running CD tile and row to show it on the next refresh, so I can watch a deploy without checking GitHub.

## 3. Outcome and success metric

- **Outcome this moves:** trust that the Running CD count reflects GitHub.
- **Primary KPI:** scans in which `loadOwnerRepos` returns another installation's repositories. Measured by the regression tests in §5, which fail if any cache hit crosses installations.
- **Baseline:** not instrumented; one confirmed occurrence on 2026-09-27 at 16:36 UTC.
- **Target:** 0, enforced by `npm test` in CI on every PR from the merge onward.
- **Guardrail metrics:** conditional (304) hit rate in steady state stays at its pre-fix level from the second scan after restart onward. The first scan after restart is allowed at most one cold pass (about 1,443 requests, below the 7,800-per-hour installation limit).

## 4. Goals and non-goals

**Goals**
1. A conditional-request cache hit returns only a body that was fetched with the same credentials (the same `installationKey`) and carries the ETag the request sent.
2. An owner's repo listing is never replaced by another installation's repositories, so a running CD run in any scanned owner's repo stays visible across every refresh.

**Non-goals**
1. Guarding against an owner listing that drops from N repos to 0 for other reasons (warning plus last-known fallback). Declined in DL-001.
2. Scanning repos that have in-progress runs when the listing or the pushed-within window drops them; that is the separate cron-only-repo gap. Declined in DL-001.

## 5. User stories and acceptance criteria

- **[P0]** As the dashboard operator, I want each installation's cached responses kept apart, so that one account's repo listing never replaces another's.
  - [ ] Given `etagCache` holds an entry for `ryabinski-labs` at `/installation/repositories?per_page=100&page=1`, when `cigan1` stores a 200 for the same URL, then the `ryabinski-labs` entry is unchanged and both entries exist under keys `ryabinski-labs <url>` and `cigan1 <url>`.
  - [ ] Given `ryabinski-labs` sent `If-None-Match: E_ryab` and `cigan1` stored its own 200 before the response arrived, when `ryabinski-labs` receives a 304, then `githubRequest` returns the `ryabinski-labs` body and `loadOwnerRepos` returns its repos, not an empty list.
  - [ ] Given PAT mode, when any GET is cached, then its key is `pat <url>`.
- **[P0]** As the dashboard operator, I want a 304 only to return the body for the ETag I sent, so that a concurrent overwrite can never be served as unchanged data.
  - [ ] Given the stored entry's ETag differs from the `If-None-Match` value the request sent, when the response is 304, then `githubRequest` repeats the request once without `If-None-Match`, stores the 200 under the same key, and returns that body.
  - [ ] Error: given the unconditional retry fails, then `githubRequest` throws the retry's `HttpError`, `fetchOwnerRepos` falls back to the last-known list, and the dashboard shows the existing warning `Could not refresh the <owner> repository list (...)`.
- **[P1]** As the dashboard operator, I want an old cache file ignored after the upgrade, so that the poisoned shared entry cannot come back after a restart.
  - [ ] Given `.cache/etag-cache.json` has `version: 1`, when the server starts, then `loadEtagCacheFromDisk` loads 0 entries and the next save writes `version: 2`.
  - [ ] Given a `version: 2` file, when the server restarts, then entries round-trip with their installation-prefixed keys.

Priorities: **P0** release fails without it · **P1** ship-blocking unless waived · **P2** follow-up.

## 6. Experience notes

Surface: none new. The only visible change is that the Running CD tile, the CD rows, and the Repos chip stop dropping one account's repos for up to 5 minutes at a time. Empty, loading, and error states are unchanged; the one error path reuses the existing repo-listing warning (see §5).

- **Accessibility bar:** unchanged; no UI is added or altered.

## 7. Scope

**In scope:** the `etagCache` key shape in `githubRequest`, a 304 ETag-match check with one unconditional retry, `ETAG_CACHE` file version 2 with v1 discarded on load, and regression tests in a new `test/etag-installation-scope.test.js`.
**Out of scope:** the empty-listing guard and live-run scanning (DL-001); changes to `OWNER_REPOS_CACHE_TTL_MS`, `selectActiveRepos`, or the UI.
**Dependencies:** none; no decision is pending.
**Permissions:** unchanged. The server binds `localhost:4177` for the single operator, and each request keeps the installation token `getGitHubToken` selects today.
**Constraints:** Node 22 or later, no new dependencies, changes confined to `server.js` plus tests (`node:test`), shipped through a PR with CI and never pushed to `main`.

## 8. Risks and open questions

| ID | Risk or question | Type | Owner | Resolve by |
|---|---|---|---|---|
| R-001 | The first scan after restart runs cold and spends about 1,443 requests on one installation bucket. | Risk | operator | Accepted in DL-002 |

## 9. Instrumentation

| Event | Trigger | Properties | Purpose |
|---|---|---|---|
| none added | not applicable | not applicable | The KPI is enforced by regression tests (A-002); the existing rate-limit readout already counts 304s per installation. |

## 10. Rollout and rollback

- **Strategy:** all at once. Merge the PR after CI passes, `git pull`, then `./start.sh restart`; `./start.sh status` confirms the new code is loaded.
- **Rollback trigger:** any `/api/status` response with `rateLimit` remaining below 1,000 on one bucket within 60 minutes of the restart, or Running CD reading 0 while GitHub shows an in-progress CD run in a scanned repo for 2 consecutive refreshes. Rollback is `git revert` of the merge through a PR, then `./start.sh restart`.
- **Migration or backfill:** the v1 cache file is discarded on load (A-001). Reversible: a reverted build ignores a v2 file the same way and starts cold.

## 11. Compliance gates

- [ ] None apply: a local, single-operator tool with no new data category, no personal data beyond what the cache already holds, and no new external service.

## 12. Data and integrations

- **Stored:** `.cache/etag-cache.json`, the same GitHub response bodies as today, keyed `<installationKey> <url>`, capped at `ETAG_CACHE_MAX_ENTRIES` (5,000) with the existing size cap. No personal data is added.
- **Migration:** file format `version: 2`; `version: 1` files are ignored on load and overwritten on the next save (A-001).
- **Integrations:** GitHub REST API through `githubRequest`, authenticated with the installation token or PAT that `getGitHubToken` already returns. Tests replace `fetch` with a stub and call the exported cache helpers directly, matching `test/etag-persistence.test.js`.

## 13. Non-functional requirements

- Steady state adds 0 requests per scan; the 304 mismatch path adds exactly 1 request per mismatched response.
- The first scan after the upgrade is allowed 1 cold pass of at most about 1,443 requests per the existing cold-scan cost.
- Cache file size stays within the existing 5,000-entry cap; four installations sharing `/installation/repositories` add at most 3 entries.

## 14. Assumptions

| ID | Dimension | Assumption | Why this default | Overturn if |
|---|---|---|---|---|
| A-001 | data | The persisted cache moves to version 2 and version 1 files are discarded on load rather than migrated. | DL-002 already accepts a cold first scan, so migrating keys saves nothing, and discarding removes the poisoned shared entry. | The operator wants the first scan after upgrade kept warm. |
| A-002 | rollout | No new telemetry; regression tests enforce the KPI and the existing rate-limit readout covers the guardrail. | Local-first tool with no telemetry pipeline. | A recurrence is seen after the fix ships. |

## 15. Decision log

| ID | Dimension | Question | Options offered | Answer | Applied in |
|---|---|---|---|---|---|
| DL-001 | purpose | Which fix should the spec cover for the run the dashboard is not showing? | A. Per-installation cache key plus ETag-match guard on 304 (recommended) B. A plus keep last-known list and warn when an owner listing drops to 0 C. A and B plus always scan repos with live runs D. Diagnosis only | A | §1, §4 |
| DL-002 | constraints | Which cache entries get the installation in their key? | A. Every entry including pat in PAT mode (recommended) B. Only URLs where extractOwnerFromPath finds no owner | A | §5, §7, §12 |
| DL-003 | errors | When a 304 arrives but the stored ETag differs from the one sent, what happens? | A. Refetch once without If-None-Match (recommended) B. Throw so the last-known fallback and warning apply C. No guard | A | §5, §13 |

## Coverage

| Dimension | Status | Ref |
|---|---|---|
| purpose | specified | §1, §3 |
| actors | specified | §2 |
| permissions | specified | §7 |
| triggers | specified | §5 |
| inputs | specified | §5 |
| outputs | specified | §5, §6 |
| states | specified | §5, §12 |
| errors | specified | §5 |
| interface | specified | §6 |
| data | assumed | §12, A-001 |
| integrations | specified | §12 |
| non_functional | specified | §13 |
| constraints | specified | §7, §11 |
| non_goals | specified | §4, §7 |
| acceptance | specified | §5 |
| rollout | assumed | §9, §10, A-002 |
