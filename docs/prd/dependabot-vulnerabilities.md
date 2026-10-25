---
spec: spec-clarifier/v1
feature: dependabot-vulnerabilities
title: Dependabot critical and high vulnerability view
status: complete
prompt: inline
prompt_sha256: b30536cdca13b4d4b5ab0fa9b4d24b53c63cbf02759c01984767157b48521c59
created: 2026-10-25
---

# PRD: Dependabot critical and high vulnerability view

## 0. Source prompt

> I want to add a tab that will show me projects with critical and high dependabot vulnerabilities use stdio to find any skills that could help @spec-clarifier

## 1. Problem

The operator runs one dashboard for pull requests, CI, CD, deployments and runners, but Dependabot alerts are not part of it. To answer "which of my projects have a critical or high vulnerability right now", they must open each repository's Security tab on GitHub, or the account's security overview, and remember which repos the dashboard is already watching.

The gap matters most for quiet repositories: the dashboard's scan set is driven by recent pushes (`SCAN_PUSHED_WITHIN_HOURS`, default 168 hours, with a 10-repo floor), so a repo nobody has touched in a week can carry an open critical alert while showing nothing here. A vulnerability is a property of the repository, not of its last push.

Evidence, from repo: no code path calls `/dependabot/alerts` today (`server.js` has only the Dependabot PR queue cleanup), and `docs/github-app-setup.md` does not request the Dependabot alerts permission. The Repos chip counts the scan set, not the accessible repo set.

## 2. Target user

- **Primary:** the operator running the local dashboard (`server.js` under the `com.ryabinski.github-monitor` LaunchAgent) with GitHub App auth across four installations: `GipsyChef`, `cigan1`, `siftfy`, `ryabinski-labs`.
- **Secondary:** anyone the operator shows the dashboard to. The view is read-only and has no per-user state, so a viewer sees the same rows as the operator.
- **Explicitly not for:** organization security managers who need triage, assignment, dismissal or audit history. That work stays on GitHub's security pages.
- **Job-to-be-done:** When I open the dashboard to see what needs attention, I want to see which projects have an open critical or high Dependabot alert, so I can go fix the worst one without checking each repo's Security tab.

## 3. Outcome and success metric

- **Outcome this moves:** time from a critical/high Dependabot alert appearing to the operator knowing which project it belongs to.
- **Primary KPI:** coverage — the share of repos with at least one open critical/high alert that appear in the view on the first scan after the permission is granted. Measured by the regression tests in §5 against a stubbed GitHub response, comparing the view's rows to the fixture's affected repos.
- **Baseline:** 0% — the feature does not exist and the dashboard makes zero Dependabot alert requests (2026-10-25).
- **Target:** 100% of accessible, non-archived repos in the selected accounts by the release date, with no affected repo silently dropped; every unreadable repo is named in the view's "not checked" line.
- **Guardrail metrics:** the dashboard's refresh interval (45-300 seconds in normal quota) and the existing rate-limit buckets do not move; the Dependabot pass adds at most one request per repo per six-hour cache TTL, so a warm 45-300 second refresh adds no alert requests.

## 4. Goals and non-goals

**Goals**
1. A new left-rail view lists every project in scope that has at least one open critical or high Dependabot alert, with separate critical and high counts.
2. The view stays correct when GitHub denies access, a repo has no Dependabot alerts enabled, or the repo listing is stale: unreadable repos are named rather than shown as clean.
3. The view refreshes with the dashboard and never delays the existing PR/CI/CD scan by more than the 30-second pass ceiling, and adds no requests on a warm scan.

**Non-goals**
1. Medium and low alerts, and closed (dismissed, fixed, auto-dismissed) alerts. Declined in DL-001; the prompt names critical and high only.
2. Code scanning, secret scanning, malware advisories and dependency-review findings. Declined in DL-001; the prompt names Dependabot.
3. Per-alert rows, alert detail pages, assignment, dismissal, or a "fix it" action. Declined in DL-001; the chosen reading is one row per project.
4. Notifications, inbox entries, or alert history/trends. The existing inbox is for CI/CD completions and conflicts; a vulnerability view is a read surface.
5. Auto-opening Dependabot PRs or auto-merging them. The existing auto-merge only acts on PRs that already exist.
6. Scanning archived repositories. `loadOwnerRepos` already filters them out (`server.js:2542`), and an archived repo cannot receive a fix without being unarchived first.

## 5. User stories and acceptance criteria

- **[P0]** As the dashboard operator, I want a Vulnerabilities view that lists every project with an open critical or high Dependabot alert, so that I can see the worst project without opening each repository's Security tab.
  - [ ] Given `acme/quiet` returns two open critical and three open high alerts, when `/api/status` is served, then `summary.vulnerableRepos` is 1, `summary.criticalAlerts` is 2, `summary.highAlerts` is 3, and the `dependabot.repos` row carries `repo`, `critical: 2`, `high: 3`, the oldest `created_at`, and `https://github.com/acme/quiet/security/dependabot`.
  - [ ] Given a repository returns only medium, low, dismissed, auto-dismissed or fixed alerts, when the pass runs, then the repository has no row and contributes 0 to both totals.
  - [ ] Given the operator types `quiet` in the filter, when the view renders, then the one matching project remains, the rail badge shows 1 of the unfiltered count, and an empty result reads as a filter miss rather than a clean account.
  - [ ] Given a repository returns 100 alerts on the first page and a `rel="next"` Link cursor, when the pass reads it, then it follows `after` for the second page and counts those alerts; no request to the endpoint carries the rejected `page` parameter.
- **[P0]** As the dashboard operator, I want the view to distinguish "not checked" from "clean", so that a denied permission or a disabled repository never reads as zero vulnerabilities.
  - [ ] Given one repository returns 403 and another returns two critical alerts, when the view renders, then the readable row stays, the notice says `1 project not checked`, names the denied repository and its reason, and the status line says `C of T projects` with the severity totals of the checked repositories only.
  - [ ] Given every repository returns 403, when the view renders, then the empty state says no readable project has an open alert and that `N projects could not be checked`; it never says "No open critical or high Dependabot alerts."
  - [ ] Error: given a browser still holds a pre-upgrade status payload with no `dependabot` section, then the empty state says `Dependabot alerts have not been checked yet. Refresh to scan.` and the rail count stays 0 rather than implying a clean account.
- **[P0]** As the dashboard operator, I want the alert pass to fit the existing scan budget, so that adding security data does not slow the PR/CI/CD scan or exhaust GitHub quota.
  - [ ] Given a repository whose alerts were read one minute ago, when the next twenty dashboard scans run, then no `/repos/{owner}/{repo}/dependabot/alerts` request is made for it until six hours have passed.
  - [ ] Given a cold pass over 200 repositories, when the pass runs, then it uses at most two lanes and a 30-second ceiling; repositories not reached by the ceiling appear in `dependabot.unchecked` with `Not checked yet — the scan budget ran out.`
  - [ ] Error: given GitHub quota is already blocked, then each attempted read returns `GitHub API quota is too low for Dependabot alerts.` in the unchecked reason, the dashboard still returns 200, and no alert request is retried inside the five-minute negative cache.
- **[P1]** As the dashboard operator, I want the view to follow the account scope I selected and exclude archived repositories, so that the list matches the projects I am responsible for.
  - [ ] Given Accounts is limited to `siftfy`, when the view renders, then only `siftfy` repositories can appear; switching All/Owned/Mine does not change the set.
  - [ ] Given the GitHub listing marks a repository archived, when the pass builds its repo list, then the repository is absent.
- **[P1]** As the dashboard operator, I want the view to stay readable and accessible at desktop, tablet and phone widths, so that severity is never carried by colour alone.
  - [ ] Given a 390px viewport, when the view renders, then the document has no horizontal overflow, each severity pill reads `N critical` or `N high`, and the notice uses a native keyboard-operable `details`/`summary` disclosure.
  - [ ] Given the view in either theme, when axe runs the WCAG 2.2 A/AA rules excluding the repo-wide contrast oracle, then it reports zero violations and zero incomplete results.
- **[P1]** As the dashboard operator, I want the required GitHub permission named where I will see it, so that I can enable the view after installing this release.
  - [ ] Given the GitHub App lacks Dependabot alerts read, when a repository returns 403, then the reason names `Dependabot alerts: Read` and the PAT alternatives (`Dependabot alerts` read for fine-grained tokens, `security_events` for classic tokens).
  - [ ] Given the operator grants the permission and approves the App update on the installation, when five minutes have passed, then the next scan replaces the denied reason with real counts without restarting the server.

Priorities: **P0** release fails without it · **P1** ship-blocking unless waived · **P2** follow-up.

## 6. Experience notes

The feature is a thirteenth left-rail view, not a second navigation system. The rail item is **Vulnerabilities** with a badge counting affected projects. A new scoreboard group was prototyped and removed: a fourth group squeezed the existing twelve tiles until `PASSING CI`, `CI RUNNING` and `FINISHED CD` truncated at 1440px (A-003). The security totals live in the view's own status line instead: `Checked 2h ago · 7 of 9 projects · 3 critical · 5 high`.

**The view.** A status line, an optional not-checked notice, then one card per affected project. Each card carries the repo label, a one-line `N open critical or high alerts` title, separate `N critical` and `N high` pills, the oldest alert's age (`Oldest 34d`), and an **Open alerts** link to `https://github.com/<repo>/security/dependabot`. The card's accent bar is red when the project has a critical alert and amber when only high alerts remain. Cards are not dismissable: a vulnerability leaves the list when GitHub says it is fixed or dismissed, not when the operator hides it locally (A-005).

**States.** Loading: the global scanning indicator, then `Checking C of T projects…` when the pass is partial. On a cold first pass the dashboard can wait up to the 30-second ceiling; the view then names every project the pass did not reach, and the next scan continues from the warm entries. Empty: `No open critical or high Dependabot alerts.` only when at least one repository was checked and none was affected; otherwise the not-checked message described in §5. Error: a listing failure is a status line naming the account; per-repo denials are grouped in the disclosure. No new toast, inbox item or browser notification.

**Responsive.** At 1440px the card is four columns (project, severity, age, action). Between 1001px and 1300px the age moves to the upper right, severity and the link take the full width. At 1000px and below every card stacks. The 390px, 1200px and 1440px layouts were rendered in both themes with no horizontal overflow.

- **Accessibility bar:** WCAG 2.2 AA. The rail item uses `aria-current`, the status line is `role="status"`, severity is always text as well as colour, the disclosure is native `details`/`summary`, and the Playwright check runs axe with zero violations and zero incomplete results.

## 7. Scope

**In scope:** a parallel Dependabot alert pass over every accessible, non-archived repo in the selected accounts; cursor pagination through the endpoint's `Link` header; a six-hour per-repo cache with a five-minute negative cache; a `dependabot` payload section and summary totals; the rail view, status line, notice, cards, responsive CSS and zero-runtime-dependency tests; README, `.env.example` and GitHub App setup documentation.
**Out of scope:** per-alert rows, alert detail pages, package or advisory grouping (DL-001); the org-level `GET /orgs/{org}/dependabot/alerts` endpoint (A-002); medium and low alerts; code scanning, secret scanning and malware advisories; notifications, inbox entries and history; dismissing, assigning, auto-fixing or auto-merging from the dashboard (A-005); a security scoreboard group (A-003); cross-project package aggregation.
**Dependencies:** the installed GitHub App must be granted **Dependabot alerts: Read**, or a PAT must carry Dependabot alerts read (fine-grained) or `security_events` (classic; `public_repo` only covers public repositories); no new service, SDK or runtime dependency.
**Constraints:** Node 22 or later, zero runtime dependencies, no build step, existing CSP, localhost-only single operator, `node:test` plus Playwright, shipped through a PR with CI and never pushed to `main`.
**Permissions:** read-only. The dashboard has no user accounts; the single operator can read the view, and every action stays on GitHub. The server uses the same `getGitHubToken` credential and per-installation `ownerHint` as the rest of the scan.

## 8. Risks and open questions

| ID | Risk or question | Type | Owner | Resolve by |
|---|---|---|---|---|
| R-001 | The installed App does not yet request Dependabot alerts, so the first render is all unchecked until the permission is granted and approved on each installation. | Risk | operator | Grant and approve before judging the feature; the view names the permission. |
| R-002 | A cold pass over roughly 200 repos adds up to 200 requests and can approach the 30-second ceiling. | Risk | operator | Watch `summary.uncheckedVulnerableRepos` and the existing quota readout after the first six-hour cycle. |
| R-003 | The Dependabot alerts REST API has carried a public-preview note; a response-shape change could zero a count. | Risk | maintainer | `summarizeDependabotAlerts` ignores unknown severities, and a 200 whose body is not an alert array is reported as unchecked rather than clean; the fixture tests pin the current shape. |
| R-004 | A pathological repo with more than 5,000 critical/high alerts is capped by `githubRestAll` at 50 pages, so its counts can be a floor. | Risk | operator | Accepted in A-007; a repo in that state has a larger operational problem. |

## 9. Instrumentation

| Event | Trigger | Properties | Purpose |
|---|---|---|---|
| `scan` (existing) | Every `/api/status` | `requestCount`, `conditionalHits`, `reposConsidered`, `reposScanned` | Guardrail: the alert pass must not move the refresh interval or the quota bucket out of its normal band. |
| `dependabot` payload (local, not emitted) | Every `/api/status` | `reposTotal`, `reposChecked`, `uncheckedRepos`, `criticalAlerts`, `highAlerts`, `checking` | KPI coverage: a repo with an alert is either a row or an unchecked entry, never silently absent. |

## 10. Rollout and rollback

- **Strategy:** all at once. Merge after CI passes, `git pull`, then `./start.sh restart`. Grant the App **Dependabot alerts: Read** in GitHub settings and approve the permission update on each installation; no flag is involved because this is a local single-operator tool.
- **Rollback trigger:** any GitHub bucket below 1,000 remaining within 60 minutes of the restart that is attributable to the alert pass, or a recommended refresh interval above 420 seconds for two consecutive scans, or a warm `/api/status` response above 120 seconds. Rollback is `git revert` of the merge through a PR, then `./start.sh restart`. Revoking the App permission is not required for rollback.
- **Migration or backfill:** none. The alert cache is in-memory and cold on restart; the first pass rebuilds it. Reversible by reverting the code, which simply stops reading the cache.

## 11. Compliance gates

- [x] None apply: a local, single-operator, read-only security view. It adds no personal data, no external service, no credential store and no user-facing terms. The alert payload copied into memory contains severity counts and dates only, not assignees or dismisser identities.

## 12. Data and integrations

- **Stored:** `dependabotAlertsCache`, an in-memory `Map` keyed by `owner/repo`. Each value is `{ ok, critical, high, oldestAt, url, checkedAt, reason }`. Successful entries expire after 21,600 seconds; failed entries after 300 seconds; both are lost on restart. The `/api/status` payload exposes `dependabot.repos`, `dependabot.unchecked`, `dependabot.checkedAt`, `dependabot.checking`, `dependabot.error` and `dependabot.counts`.
- **Migration:** none. No disk file, database, schema or backfill is added.
- **Integrations:** GitHub REST `GET /repos/{owner}/{repo}/dependabot/alerts?state=open&severity=critical,high&per_page=100` through `githubRestAllByLink`, authenticated by `getGitHubToken` with the repo owner as `ownerHint`. The endpoint rejects `page`, so the reader follows the `after` cursor from the `Link` header; ETags are disabled for this reader because a 304 carries no Link. Rate-limit buckets are inherited. Tests replace `globalThis.fetch` with deterministic stubs, matching `test/owner-repo-listing-fallback.test.js` and `test/scan-scope.test.js`.

## 13. Non-functional requirements

- One alert result per repository is reused for 21,600 seconds; a failed read is retried after 300 seconds.
- At 200 accessible repos the warm cost is at most 200 requests per six hours, about 33 per hour; the first cold pass is at most 200 requests.
- The pass uses 2 parallel lanes, a 30,000 ms ceiling, 100 alerts per page, the Link `after` cursor and a 50-page cap.
- The pass runs concurrently with the existing PR/CI/CD scan; it adds at most 30,000 ms to a cold response, adds none on a warm scan, and does not change the 45-300 second refresh recommendation.
- The view has no horizontal overflow at 390, 1200 and 1440 CSS pixels in both themes.
- Axe reports zero WCAG 2.2 A/AA violations and zero incomplete results on the view; severity is text, not colour alone.
- No new secret, endpoint, CSP directive or runtime dependency is introduced; all requests stay on `127.0.0.1` and the GitHub API.

## 14. Assumptions

| ID | Dimension | Assumption | Why this default | Overturn if |
|---|---|---|---|---|
| A-001 | rollout | The GitHub App permission is granted by hand in GitHub settings and approved on each installation; until then the view reports every repo as not checked. | App permissions are managed outside the repository and cannot be granted by code. | The operator wants an optional `DEPENDABOT_TOKEN` with Dependabot alerts access instead of changing the App. |
| A-002 | integrations | Use the repo-level alerts endpoint for every repository, not the org-level endpoint. | One code path works for user and org repos with the same App token; the org endpoint requires an org owner or security manager. | Request volume makes the org-level endpoint worth a second auth path. |
| A-003 | interface | No scoreboard tile group; severity totals live in the view status line. | A fourth group squeezed the existing twelve tiles until labels truncated at 1440px in the visual pass. | The scoreboard is redesigned to wrap without shrinking the existing tiles. |
| A-004 | actors | The All/Owned/Mine PR filter does not narrow the view; the Accounts picker does. | The filter describes PR authorship and ownership, while the prompt asks for projects; archived repos are already excluded by `loadOwnerRepos`. | The operator expects Mine to mean only repositories they own. |
| A-005 | states | Vulnerability cards are not dismissable and offer only the GitHub link. | Hiding a vulnerability locally would make the list lie; GitHub already owns dismissal with a reason. | The operator asks for local triage or acknowledgement. |
| A-006 | errors | A denied or disabled repo is cached for 300 seconds; a successful read for 21,600 seconds. | Prevents a missing permission from being retried on every 45-second refresh while still recovering quickly after a grant. | The App permission is expected to change minute-to-minute. |
| A-007 | inputs | Counts are per alert, not per unique package; duplicate alerts across manifests count separately, and more than 5,000 are capped. | Matches GitHub's own alert list; the cap keeps a pathological repo from making the pass unbounded. | The operator wants package-level deduplication or a hard fail above the cap. |
| A-008 | outputs | The age shown is the oldest open critical/high alert's `created_at`, not `updated_at`. | It measures how long the project has been exposed, which is the decision the operator is making. | The operator wants time since the advisory last changed. |
| A-009 | non_functional | A cold pass may be partial after 30 seconds and the dashboard may wait up to that ceiling; the view names what it did not check and fills in on a later scan. | The six-hour cache makes cold starts rare, the 30-second ceiling sits inside the existing cold-scan envelope, and partial data is better than an unbounded pass. | A complete first paint is worth a longer dashboard wait, or the pass should move to a background job. |

## 15. Decision log

| ID | Dimension | Question | Options offered | Answer | Applied in |
|---|---|---|---|---|---|
| DL-001 | purpose | You wrote "add a tab that will show me projects with critical and high dependabot vulnerabilities". Which reading is yours? | A. Rail view, one row per repo with critical/high counts and a GitHub link, fed by a cached pass in the existing scan (recommended) B. Rail view, one row per alert with package, advisory and patched version C. Rail view, one row per repo but fetched lazily from a new GET /api/dependabot D. Scoreboard tile only, links to GitHub | A | §1, §4, §5 |
| DL-002 | triggers | Which projects should the vulnerability view cover when the dashboard scan drops repos with no push in 168 hours and a quiet repo can still carry an open critical alert? | A. All accessible repos (recommended) B. Only the active scan set C. All repos, allowlisted | A | §5, §7, §12 |
| DL-003 | errors | GitHub can deny a repo's alerts (missing GitHub App permission, PAT without Dependabot alerts access, Dependabot disabled, or a 404). What should the view show then? | A. Readable rows plus a not-checked line (recommended) B. Setup screen when permission is missing C. Whole-view error | A | §5, §6 |
| DL-004 | states | Which Dependabot alert states should count toward a project's critical/high totals? | A. Open only (recommended) B. Open plus dismissed C. Open plus fixed in the last 7 days | A | §5, §12 |
| DL-005 | non_functional | How long should one repo's Dependabot result be reused before the next GitHub call at roughly 200 accessible repos? | A. 6 hours (recommended) B. 3 hours C. 12 hours D. 24 hours; custom answer: longer cache, fewer GitHub calls | 6 hours | §5, §12, §13 |

## Coverage

| Dimension | Status | Ref |
|---|---|---|
| purpose | specified | §1, §3 |
| actors | specified | §2, A-004 |
| permissions | specified | §7, §12 |
| triggers | specified | §5, §12, DL-002 |
| inputs | specified | §5, §12, A-007 |
| outputs | specified | §5, §6, §12, A-008 |
| states | specified | §5, §6, DL-004, A-005 |
| errors | specified | §5, §6, §12, DL-003, A-006 |
| interface | specified | §6, §13, A-003 |
| data | specified | §12 |
| integrations | specified | §12, A-002 |
| non_functional | specified | §13, A-009 |
| constraints | specified | §7 |
| non_goals | specified | §4, DL-001 |
| acceptance | specified | §5 |
| rollout | specified | §10, A-001 |
