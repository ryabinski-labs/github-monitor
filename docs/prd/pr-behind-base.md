---
spec: spec-clarifier/v1
feature: pr-behind-base
title: Out-of-date PR lane with Update branch action
status: complete
prompt: inline
prompt_sha256: 2f53d2d06135b009dae2c086ef62096bfd1509eb4eb6f0b1e52372982b4346c4
created: 2026-09-18
---

# PRD: Out-of-date PR lane with Update branch action

## 0. Source prompt

> some workloads get stuck in this update branch status, can we show it separately and I want to be able to click update branch right from github monitor
>
> [Screenshot of a GitHub PR page showing: "Some checks were not successful — 1 failing, 2 skipped, 28 successful checks", a list of CI check rows, and below it the banner "This branch is out-of-date with the base branch / Merge the latest changes from main into this branch. This merge commit will be associated with cigan1." with an "Update branch" button and dropdown, above a disabled "Merge pull request" button.]

## 1. Problem

PRs get "stuck in this update branch status": their head branch falls behind the base branch,
GitHub disables **Merge pull request** and shows a *"This branch is out-of-date with the base
branch"* banner, and the only way to unstick them is to open each PR on github.com and click
**Update branch**. The dashboard cannot currently see this state at all -- the scan's GraphQL
query fetches `mergeable`, which only reports `MERGEABLE` / `CONFLICTING` / `UNKNOWN`
(`server.js:65`, `server.js:1961`), so a behind PR is indistinguishable from a ready one and
sits silently in the Passing CI or Failing CI lane while never merging.

Evidence: the source screenshot shows a PR with 28 successful checks, 1 failing check, and a
disabled merge button under the out-of-date banner.

## 2. Target user

- **Primary:** The single operator running github-monitor locally against their own
  repositories -- the dashboard is local-first and single-user by construction (binds
  `127.0.0.1`, `server.js` listen block; no accounts or sessions exist).
- **Secondary:** none. There is no multi-user surface.
- **Explicitly not for:** read-only observers; every existing action button (merge, close,
  rerun) already assumes the viewer may write to the repository.
- **Job-to-be-done:** When a PR stops merging because its branch fell behind base, I want to
  see it in its own lane and update it without leaving the dashboard, so I can unstick it in
  one click instead of opening github.com per PR.

## 3. Outcome and success metric

- **Outcome this moves:** Time a PR spends blocked solely because its branch is behind base,
  and the number of github.com round trips needed to clear that block.
- **Primary KPI:** Clicks-to-unstick -- the number of user actions between seeing a
  behind-base PR and issuing the update. Measured by inspection of the flow, not telemetry.
- **Baseline:** 4 actions as of 2026-09-18 (notice the PR is not merging, open it on
  github.com, scroll to the banner, click Update branch) and the first action is impossible
  today because the dashboard never reports the state at all.
- **Target:** 1 action -- the Update branch button on the Out-of-date row -- from the first
  release of this feature.
- **Guardrail metrics:**
  - Requests per scan must not increase (0 additional HTTP requests, DL-002).
  - The PR pass must still complete inside `SCAN_PASS_DEADLINE_MS` (180000 ms,
    `server.js:309`); a partial-scan banner appearing after this change is a regression.
  - Inbox entries per scan must not rise enough to evict unrelated alerts from the
    60-entry, 24h inbox (`INBOX_MAX`, `public/app.js:15`), which is what DL-008 bounds.

## 4. Goals and non-goals

**Goals**
1. A PR whose head is behind its base branch is visible as such, in one place, without
   opening github.com.
2. Bringing such a PR up to date takes one click from the dashboard.

**Non-goals**
1. **No bulk "Update all"** (DL-004). Every update starts a fresh CI run, and this dashboard
   already tracks self-hosted runner capacity; one deliberate click per PR keeps that load
   visible. No existing dashboard action is bulk.
2. **No server-side auto-update** (DL-001, option D rejected). The server never writes to a
   repository without a click; the auto-merge scan loop is not extended.
3. **No rebase option** (DL-003). Rebase force-pushes the head branch and rewrites SHAs; the
   button always creates a merge commit, matching GitHub's default and the banner text.

## 5. User stories and acceptance criteria

- **[P0]** As the operator, I want open PRs whose head branch is behind its base branch
  collected in their own lane, so that I stop hunting for PRs that silently will not merge.
  *(S1 -- see the stuck PRs in one place.)*
  - [ ] Given an open PR with `behindBy > 0` and `hasConflict === false`, when a scan completes, then the PR appears in the `behind` group and in **no** other PR group (`pass`, `noCi`, `fail`, `running`), and the `Out of date` rail count equals the number of such PRs.
  - [ ] Given an open PR with `behindBy > 0` **and** `hasConflict === true`, when a scan completes, then the PR appears in the `conflicts` group and not in `behind` (DL-005).
  - [ ] Given an open PR with `behindBy === 0`, when a scan completes, then it is grouped exactly as it is today and the `behind` group does not contain it.
  - [ ] Given no PR is behind its base, when the `Out of date` view is selected, then the empty state reads `No PRs waiting on a branch update.` and no rows render.

- **[P0]** As the operator, I want to click **Update branch** on an Out-of-date row, so that
  the PR is brought up to date without opening github.com.
  *(S2 -- update the branch in one click.)*
  - [ ] Given an Out-of-date row, when it renders, then it carries an `Update branch` button in `.row-actions`, before the Merge button.
  - [ ] Given the operator clicks `Update branch`, when the request is issued, then it is `POST /api/pull-request/update-branch` with body `{ repo, number }`, and the server calls `PUT /repos/{repo}/pulls/{number}/update-branch` with **no** `update_method` field, so GitHub performs a merge-commit update (DL-003).
  - [ ] Given the request is in flight, when the row re-renders, then the button label reads `Updating`, the button is disabled, and a second click issues no second request -- matching `state.merging` handling in `mergePullRequest` (`public/app.js:3134`).
  - [ ] Given GitHub returns 2xx, when the response is handled, then the button reads `Updated` and stays disabled, a toast titled `Branch updated` names the repo, number and title, and `refreshAfterMutation("update-branch")` runs so the next scan removes the row from the lane.
  - [ ] Given the PR head is a fork branch, when the compare is built, then the head ref is qualified as `<headRepoOwner>:<headRefName>` so `behindBy` is correct across repositories (A-004).

- **[P0]** As the operator, I want a failed update to tell me why, so that I can tell a
  branch-protection refusal from a fork I cannot push to.
  *(S3 -- a rejected update explains itself.)*
  - [ ] Error: given GitHub returns 403 because the App identity may not push to the head branch, then a toast titled `Update failed` carries GitHub's own message verbatim, the same message is set in the error panel via `setError`, and the button returns to the enabled `Update branch` state (DL-009).
  - [ ] Error: given GitHub returns 422 because the update would conflict, then the same failure path runs and the row stays in the lane; nothing is optimistically removed.
  - [ ] Error: given the fetch itself rejects (server down, timeout), then the catch branch produces the `Update failed` toast and the `finally` branch clears the in-flight state, so the button is never permanently stuck disabled.
  - [ ] Given any failure, when it is handled, then no PR is removed from the lane and no success toast is shown.

- **[P1]** As the operator, I want a notification when a PR becomes blocked solely by being
  behind, so that I act without re-reading the rail.
  *(S4 -- told when a PR is stuck on nothing but the update.)*
  - [ ] Given a PR newly enters the `behind` group with `state === "pass"`, `isDraft` false and `hasConflict` false, when notifications are evaluated, then `sendPopup` fires once with title `Branch out of date`, body `<repo> <numberLabel>: <title>`, tag `behind:<prKey>`, and `url` set to the PR url (DL-007, DL-008).
  - [ ] Given a PR newly enters the `behind` group with `state === "fail"`, `state === "running"`, `isDraft` true, or `checkCount === 0`, when notifications are evaluated, then no popup and no inbox entry is produced.
  - [ ] Given a PR is already in the `behind` group from the previous snapshot, when a later scan completes, then no second popup fires -- the existing `wasNotified(tag)` guard in `sendPopup` (`public/app.js:1192`) is the mechanism.

- **[P1]** As the operator, I want the row to say how far behind the branch is, so that I can
  judge how risky the update is before clicking.
  *(S5 -- see how far behind it is.)*
  - [ ] Given a row with `behindBy >= 1`, when it renders, then its tag group shows a pill whose visible text is `<behindBy> BEHIND <baseRefName>` (uppercased by CSS, e.g. `12 BEHIND MAIN`) preceded by a down-arrow glyph, and whose `title` carries the full sentence `12 commits behind main -- merge the latest main into this branch` (singular `1 commit behind` when `behindBy === 1`).
  - [ ] Given a `baseRefName` longer than 22 characters, when the pill renders, then the branch name truncates with an ellipsis and the untruncated name remains in the `title`, and the row does not scroll horizontally at a 1280 px viewport.
  - [ ] Given `behindBy` is missing or not a positive integer, when grouping runs, then the PR is not placed in the `behind` group at all and is grouped as it is today (A-003).

- **[P1]** As the operator, I want a merely-behind PR to stay mergeable from its new lane, so
  that moving it did not cost me a capability (DL-006).
  *(S6 -- merge straight from the lane.)*
  - [ ] Given an Out-of-date row whose `mergeBlockReason()` is empty, when it renders, then an enabled `Merge` button appears beside `Update branch`, and clicking it runs the existing `POST /api/pull-request/merge` flow unchanged.
  - [ ] Given an Out-of-date row whose `mergeBlockReason()` is non-empty, when it renders, then the Merge button is disabled and its `title` is that reason -- the same gate used in every other lane today.
  - [ ] Given any Out-of-date row, when it renders, then it also carries `Close`, `Open PR` and the dismiss control, and a failing one additionally carries `Rerun failed`.
  - [ ] Given any Out-of-date row, when it renders, then exactly 1 button in `.row-actions` uses a filled style and it is `Update branch`; `Merge`, `Rerun failed`, `Close` and `Open PR` all render outlined, preserving the one-filled-primary-per-row invariant the `pass`, `fail` and `running` lanes already hold (A-009).

Priorities: **P0** release fails without it · **P1** ship-blocking unless waived · **P2** follow-up.

## 6. Experience notes

**Surface:** the existing single-page dashboard at `http://127.0.0.1:<port>` plus one new
server route. No CLI, no background job, no new page.

**Rail item.** A new `Out of date` entry in `#rail` (`public/index.html:280`), placed
immediately after `Conflicts` so the two blocked lanes sit together, with a live count in
`<strong id="navBehind">` wired through the `navKeys` map (`public/app.js:245`). Dot colour
`amber` -- red is taken by hard failures and conflicts, and being behind is a nudge, not a
breakage (A-001).

**View header.** kicker `Out of date`, title `PRs whose branch is behind the base branch`,
empty state `No PRs waiting on a branch update.`, colour `amber` -- registered in the `views`
map (`public/app.js:98`) and appended to `viewOrder` after `conflicts`.

**Row.** The existing `renderPrRow` shape, with one added pill in the tag group next to the
Conflict and Draft pills, reading `N commit(s) behind <baseRefName>`, and one added button in
`.row-actions` (S5, S6).

**Button states** -- the four states every action button in this dashboard already uses:

| State | Label | Disabled | Trigger |
|---|---|---|---|
| ready | `Update branch` | no | default |
| in flight | `Updating` | yes | click, until the response resolves |
| done | `Updated` | yes | 2xx response, until the next scan drops the row |
| failed | `Update branch` | no | any error; toast and error panel carry the reason |

**Loading:** unchanged -- the whole view is replaced by `#loading` during a scan.
**Error:** unchanged -- `#errorPanel` plus a toast, the path merge and close already use.
**Returning user:** nothing is persisted for this lane beyond the existing notification and
dismiss keys, so a reload shows whatever the current scan reports.

- **Accessibility bar:** WCAG 2.2 AA. **Correction:** `axe-core` is declared in
  `devDependencies` but is imported by nothing -- there is no accessibility test in the repo
  today, so there is no "existing axe pass" to inherit. This feature adds the first one,
  injecting `axe-core` into the already-running Playwright page the `test/` suite uses
  (`test/filter-visibility.test.js` is the pattern). Concretely: the button carries
  `aria-label="Update branch <repo> <numberLabel>"`, the behind pill carries a `title`
  explaining the state, the rail count sits inside the existing button label so it is
  announced with the item, and the new view must report 0 axe violations at AA.
- **Contrast:** verified by computation, not by eye. In the dark theme amber pill text on
  `--amber-soft` is 6.15:1 and the filled amber button is 8.49:1. In the light theme the naive
  `color: var(--amber)` pill measures **3.77:1 and fails AA**, so the pill uses a new
  `--amber-on-soft` token (`#7b4f0e` in light, `var(--amber)` in dark) measuring 5.29:1 --
  following the `--flag-on-soft` convention already in `styles.css:28`. The filled amber
  button measures 4.67:1 in light, above the 4.5:1 floor.

## 7. Scope

**In scope:**
- `behindBy` and `baseRefName` on every scanned PR, from the existing GraphQL query.
- A sixth, exclusive PR group `behind` in `groupPullRequests` (`server.js:4305`).
- A rail item, a `views` entry, a behind pill and an `Update branch` button in the front end.
- `POST /api/pull-request/update-branch` calling GitHub's update-branch endpoint.
- A scoped popup when a PR becomes blocked solely by being behind.
- Tests in `test/` covering grouping, precedence, the route, and the failure paths.

**Out of scope:**
- Bulk update (DL-004), server-side auto-update (DL-001), rebase (DL-003), a header toggle
  (DL-010).
- Any change to conflict handling, auto-merge, CD tracing, deployments or runners.
- Any change to how PRs are discovered or which repositories are scanned.
- Reporting *why* GitHub considers a branch out of date (branch protection settings are not
  read).

**Dependencies:**
- GitHub GraphQL `Ref.compare(headRef:)` returning `behindBy` (verified against the live schema by
  introspection on 2026-09-18, R-001).
- GitHub REST `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch`.
- `Contents: Read & write` on the App installation, already requested
  (`docs/github-app-setup.md:45`); PAT mode needs `repo` scope, which merge already requires.

**Constraints:**
- Zero runtime dependencies. `package.json` has no `dependencies` block and this must not add
  one; `axe-core`, `fast-check` and `playwright` stay dev-only.
- Node >= 22, ES modules, the project's existing style. No build step.
- Local-first: state stays in memory and `localStorage`; no cloud datastore.
- The CSP and `SECURITY_HEADERS` in `server.js:55` are enforced by `test/csp.test.js`; no
  inline script or external asset may be introduced.
- Every change ships on a feature branch through a pull request and CI; nothing is pushed to
  `main` directly.

## 8. Risks and open questions

| ID | Risk or question | Type | Owner | Resolve by |
|---|---|---|---|---|
| R-001 | **Resolved 2026-09-18.** `Ref.compare(headRef: String!): Comparison` was confirmed against the live GitHub GraphQL schema by introspection; `Comparison` exposes `aheadBy`, `behindBy`, `status`, `commits`, `baseTarget`, `headTarget`. DL-002 stands and the zero-extra-requests guarantee holds. The fork-qualified `owner:branch` head ref (A-004) is the remaining untested input. | Risk | Implementer | Closed |
| R-002 | Risk: adding `compare` per PR may raise GraphQL point cost or server-side latency enough to push the PR pass past `SCAN_PASS_DEADLINE_MS` (180000 ms). Measure the pass duration before and after on the largest installation. | Risk | Implementer | Before merge |
| R-003 | Risk: under GitHub App auth the update merge commit is attributed to the App, not to the operator -- your screenshot's banner reads "This merge commit will be associated with cigan1." Some branch protection rules refuse App pushes entirely (`docs/github-app-setup.md:133`), which surfaces only as the DL-009 error toast. | Risk | Operator | Accepted; no mitigation planned |
| R-004 | Risk: `behindBy` is computed at scan time, so a PR can fall behind between the scan and the click. The update still succeeds (GitHub recomputes), but a PR can also *stop* being behind, in which case GitHub returns 422 and the DL-009 error path fires on a PR that needed nothing. | Risk | Implementer | Accepted; the error copy must not imply a failure the operator caused |

## 9. Instrumentation

No analytics pipeline exists and none is added -- this dashboard is local-first with no cloud
state by deliberate constraint, so "instrumentation" here means locally observable surfaces
only.

| Event | Trigger | Properties | Purpose |
|---|---|---|---|
| `Out of date` rail count | Every completed scan | integer count of the `behind` group | The population this feature exists to make visible; reading it as non-zero is the proof detection works |
| Inbox entry `behind:<prKey>` | A PR becomes blocked solely by being behind | repo, number, title, PR url | Counts how often the stuck-on-update case actually occurs, and bounds the flood risk DL-008 addresses |
| Toast `Branch updated` / `Update failed` | Response to `POST /api/pull-request/update-branch` | repo, number, GitHub's message on failure | Distinguishes a working action from a permission or protection refusal (R-003) |
| `/api/health` quota buckets | Any request to `/api/health` | per-installation remaining, limit | Confirms the zero-extra-requests guardrail in §3; this route spends no quota to read |

## 10. Rollout and rollback

- **Strategy:** Full release on merge, no flag and no cohort (DL-010). The audience is one
  operator running the server locally; a flag would be a toggle the user declined.
  Ships on a feature branch, through a pull request, merged only once CI is green.
- **Rollback trigger:** Revert the pull request if any of: the PR pass exceeds
  `SCAN_PASS_DEADLINE_MS` and the partial-scan banner appears (R-002); requests per scan rise
  above the pre-change count; or the GraphQL query starts erroring, which would empty every PR
  lane, not just this one. Rollback is a `git revert` plus a server restart -- there is no
  migration to undo.
- **Migration or backfill:** None. No persisted shape changes, so an older client against a
  newer server simply ignores the new field, and a newer client against an older server sees
  `behindBy` undefined and, per A-003, groups every PR exactly as it does today.

## 11. Compliance gates

- [x] **None apply.** No new personal data is collected, stored or transmitted: `behindBy` is
  an integer and `baseRefName` is a branch name, both already public in the repositories being
  scanned. Nothing new is written to disk. The server binds `127.0.0.1` only, and no data
  leaves the machine except the GitHub API calls the dashboard already makes under the
  operator's own credentials.
- [x] **Licence:** MIT, unchanged. No dependency is added, so no new licence obligation.

## 12. Data and integrations

- **Stored:** Nothing new is persisted server-side. `behindBy` rides on the in-memory PR
  object built by `classifyPullRequest` (`server.js:1959`) alongside `mergeable` and
  `hasConflict`, and is discarded on the next scan. No personal data is added. This keeps the
  local-first, no-cloud-state constraint intact.
- **Migration:** None. No schema, no disk format change; the ETag cache on disk is unaffected.
- **Integrations:**
  - **GitHub GraphQL** (`githubGraphql`, `server.js:1098`) -- detection. `PR_SEARCH_GRAPHQL`
    and `PR_BY_NUMBER_GRAPHQL` (`server.js:65`, `server.js:126`) gain
    `baseRef { compare(headRef: <head>) { behindBy } }`. Auth is the existing App-installation
    or PAT token; no new credential, no new Accept header.
  - **GitHub REST** `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` -- the action.
    Called through the existing `githubRequest` helper. Needs `Contents: Read & write`, which
    the App already requests (`docs/github-app-setup.md:45`); no new permission.
  - **Tests:** replaced the way `test/server.test.js` and `test/rerun-failed.test.js` already
    stub GitHub -- `node --test` with the fetch layer intercepted. No new test dependency.

## 13. Non-functional requirements

- **Requests per scan: +0.** Detection adds no HTTP request; `behindBy` rides inside the
  GraphQL query the scan already issues (DL-002). Measured by comparing the per-installation
  `remaining` delta across one full scan at `/api/health` before and after.
- **PR pass duration: within `SCAN_PASS_DEADLINE_MS` = 180000 ms** (`server.js:309`), at the
  existing concurrency of `DEFAULT_SCAN_JOBS = 8`, on the largest installation the operator
  scans. Measured at the scan-metrics store that already reports partial scans (R-002).
- **Update action round trip: under `GITHUB_REQUEST_TIMEOUT_MS` = 30000 ms**
  (`server.js:293`), inherited unchanged by using `githubRequest`; a slower response surfaces
  as the DL-009 failure toast rather than a hung button.
- **Popups per scan from this feature: at most 1 per PR that is passing, not draft, not
  conflicting and newly behind, and exactly 0 on any scan where no PR newly qualifies**
  (DL-008). Measured by counting new `behind:` tags in the inbox per scan; the count is
  structurally a subset of the `behind` group size.
- **Accessibility: 0 axe-core violations** at WCAG 2.2 AA over the Out-of-date view with at
  least 1 row rendered, in **both** themes, measured by a new axe pass injected into the
  existing Playwright harness (no such pass exists today -- see §6).
- **Contrast: every new foreground/background pair >= 4.5:1** in both the dark and light
  themes, measured by computing WCAG relative luminance on the token values rather than by
  inspection. Lowest measured pair after the `--amber-on-soft` fix: 4.67:1.
- **Bundle and dependency cost: +0 runtime dependencies**, enforced by `package.json` having
  no `dependencies` block.

## 14. Assumptions

| ID | Dimension | Assumption | Why this default | Overturn if |
|---|---|---|---|---|
| A-001 | interface | The lane uses the `amber` dot and accent, and sits directly after `Conflicts` in the rail and in `viewOrder`. | Red is already carried by Failing CI and Conflicts, which are breakages; being behind is a nudge. Placing it next to Conflicts groups the two blocked lanes. | The operator wants blocked-on-update treated with the same urgency as a failure, or wants the lane first in the rail. |
| A-002 | interface | The rail label is `Out of date`, the pill reads `N BEHIND <base>` with the full `N commits behind <base>` sentence in its `title`, and the empty state reads `No PRs waiting on a branch update.` | Mirrors GitHub's own wording in the banner the operator screenshotted, so the two surfaces agree. The pill drops the word "commits" because at 9.5 px with 0.12em tracking the full sentence renders ~165 px and crowds the `[FAIL] [DRAFT]` pills beside it. | The operator prefers "Behind base" or "Needs update" as the label, or wants the full sentence visible. |
| A-009 | interface | `Update branch` is the single filled button on an Out-of-date row; `Merge` and `Rerun failed` render outlined in this lane only, scoped by a new `data-view` attribute on `#content`. | Descriptive of the existing system, not invented: the `pass`, `fail` and `running` lanes each already render exactly one filled button per row. Without scoping, a failing, behind, mergeable PR would render three filled buttons competing for the same glance. | The operator wants Merge to stay visually primary everywhere it appears. |
| A-010 | interface | The rail dot for this lane is amber and hollow (a ring), not filled. | Amber is already the `running` lane's dot colour, so colour alone would not separate them in the rail; a ring reads as a static blocked state against `running`'s filled dot, and does not rely on colour as the sole distinguishing channel. | The operator wants a distinct hue instead, in which case `violet` is unused in the PR block. |
| A-003 | states | If `behindBy` is absent, null, or not a positive integer, the PR is grouped exactly as today and never lands in the `behind` lane. | Fail-open. A GraphQL field that errors or is unavailable must not silently empty every other lane; today's grouping is the safe fallback. | The operator would rather see a loud error than a silently missing lane. |
| A-004 | inputs | For a PR whose head lives in a fork, the compare head ref is qualified as `<headRepoOwner>:<headRefName>`; same-repo PRs pass the bare branch name. | Cross-repository compare needs the owner prefix, and `headRepository` costs nothing to add to the scan query. | Fork PRs turn out not to compare correctly, in which case they are excluded from the lane and the exclusion is documented. |
| A-005 | states | After a successful update the row keeps its `Updated` button and stays in the lane until the next scan removes it, driven by `refreshAfterMutation`. | Exactly how merge and close behave today (`public/app.js:3134`); optimistic removal would hide a PR whose update GitHub had only queued (202). | The operator finds the lingering row confusing. |
| A-006 | permissions | Draft PRs that are behind appear in the lane with a working `Update branch` button. | Updating a draft is legitimate and GitHub allows it; only merging is gated on draft status. | The operator wants drafts excluded from the lane entirely. |
| A-007 | errors | Clicking `Update branch` shows no confirmation dialog. | No action button in this dashboard confirms -- merge, close and rerun all fire on click, and merge is the more consequential of the two. | The operator wants a confirm because an update starts a CI run on the PR. |
| A-008 | acceptance | Tests land as a new `test/behind-base.test.js` alongside additions to `test/server.test.js`, run by `node --test`. | Matches the one-file-per-behaviour convention already in `test/` (`rerun-failed.test.js`, `filter-visibility.test.js`). | The implementer finds the grouping tests fit better inside `server.test.js`. |

## 15. Decision log

| ID | Dimension | Question | Options offered | Answer | Applied in |
|---|---|---|---|---|---|
| DL-001 | purpose | Interpretation: what does "show it separately" mean for a PR that is both behind base and failing CI? | A. exclusive lane like Conflicts; B. additive lane, PR appears in both; C. badge + button only, no lane; D. exclusive lane + server-side auto-update | A -- exclusive lane, like Conflicts | §4, §5, §6 |
| DL-002 | inputs | What counts as "stuck in update branch status" and lands in the lane? | A. any PR whose head is behind base, via `baseRef.compare(headRef:)` in the existing GraphQL query; B. only `mergeStateStatus == BEHIND`; C. REST per-PR `mergeable_state` | A -- any PR behind base, GraphQL compare, zero extra requests | §6, §12 |
| DL-003 | triggers | Which update method does the button use? | A. merge commit always (GitHub default); B. rebase always (force-push); C. per-click choice via split button | A -- merge commit, always | §5, §12 |
| DL-004 | non_goals | Bulk lane-level action in addition to the per-row button? | A. per-row button only; B. add "Update all N" for the lane | A -- per-row only | §4, §7 |
| DL-005 | states | A PR both behind base and conflicting -- which exclusive lane wins? | A. Conflicts wins; B. Out of date wins | A -- Conflicts wins; the behind lane takes `!hasConflict && behindBy > 0` | §5, §6 |
| DL-006 | outputs | Which actions does an Out-of-date row carry? | A. Update + Merge + Close + Open PR; B. Update + Close + Open PR only | A -- Merge stays available under the existing `mergeBlockReason()` gate | §5, §6 |
| DL-007 | outputs | Should entering the Out-of-date lane fire a desktop notification, as merge conflicts do? | A. no notification; B. notify, same as conflicts | B -- notify (user chose against the recommendation; flood control settled in DL-008) | §5, §6 |
| DL-008 | outputs | How is the notification scoped so one merge to main does not flood the 60-entry inbox? | A. only when behind is the only blocker; B. one coalesced popup per scan; C. one per PR, exactly like conflicts | A -- notify only when `state === "pass" && !isDraft && !hasConflict` | §5, §6 |
| DL-009 | errors | How are `PUT /update-branch` rejections (fork, branch protection vs App identity) handled? | A. always show the button, report GitHub's error on failure; B. pre-disable on fork PRs | A -- always show; surface GitHub's own message, no pre-flight check | §5, §6 |
| DL-010 | rollout | Does the lane get a header toggle like CD, runners, auto-merge? | A. always on, no toggle; B. header toggle, default on | A -- always on; no PR lane has a toggle today | §6, §7 |
| DL-011 | acceptance | Which stories are P0? | A. S1-S3 as P0; B. add S5 to P0; C. add S5 and S6 to P0; D. S1 and S2 only | A -- S1 (lane), S2 (button), S3 (error path) are P0; S4, S5, S6 are P1 | §5 |

## Coverage

| Dimension | Status | Ref |
|---|---|---|
| purpose | specified | §1, §4 |
| actors | specified | §2 |
| permissions | specified | §2, A-006 |
| triggers | specified | §5, DL-003 |
| inputs | specified | §12, DL-002, A-004 |
| outputs | specified | §5, DL-006, DL-007, DL-008, A-005 |
| states | specified | §5, DL-005, A-003 |
| errors | specified | §5, DL-009, A-007 |
| interface | specified | §6, A-001, A-002, A-009, A-010 |
| data | specified | §12 |
| integrations | specified | §12 |
| non_functional | specified | §13 |
| constraints | specified | §7 |
| non_goals | specified | §4, DL-004 |
| acceptance | specified | §5, DL-011, A-008 |
| rollout | specified | §10, DL-010 |
