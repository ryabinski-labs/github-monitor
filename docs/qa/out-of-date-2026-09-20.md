# Out-of-date detection QA — 2026-09-20

Scope: detection/cache changes and the Out of date user journey. The product is a local GitHub operations dashboard for a repository operator. No production actions, live notifications, email, payments, or external GitHub mutations were used for this QA run.

## Findings and fixes

- [#135](https://github.com/ryabinski-labs/github-monitor/issues/135), High: recorded PR base commit can remain unchanged after the live base moves, hiding stale PRs behind cached zeros. Both queries now retrieve `baseRef.target.oid`; comparisons cache only known counts with complete commit identities. Partial comparisons retry. Two regressions were demonstrated failing before the fix and pass afterward.
- [#136](https://github.com/ryabinski-labs/github-monitor/issues/136), Medium, visual specialist confirmed: branch pill and check summary overlapped about 99×13px at 1440×900. Behind rows now reserve the pill width and wrap actions on their own line above 1300px. Geometry regression fails against original CSS and passes in both themes at 375, 390, 430, 1280, 1440 and 1728px.
- Test oracle drift repaired: endpoint tests now exercise actual HTTP routing and record GitHub requests, rather than checking only a builder or an unconnected empty call list. Browser tests now assert completed button state, follow-up scan, failure toast, and notification body/tag/URL. No remaining oracle failures in the scoped artifact.

## Environment and scenario loop

Baseline: Node.js 25.2.1 on macOS for the repository suite; Podman 6.0.2 running `node:22-alpine`, real server/public assets, synthetic GitHub transport, 51 PRs. Local QA URL `http://127.0.0.1:4178`. Native tests bypass local `.env` with `NODE_ENV=test`; the container contains no credentials or local environment files.

Podman startup initially rejected `/tmp/github-monitor-qa-env` because that host path is unavailable inside its VM (`statfs: no such file or directory`). Copying only source/public files and the synthetic harness into ignored `.cache/qa-outdated` made the home-directory bind mount work. Container command:

```sh
podman run -d --rm --name github-monitor-qa-outdated \
  -p 127.0.0.1:4178:4178 \
  -v /Users/cigan/projects/github-monitor/.cache/qa-outdated:/app:ro \
  -w /app -e NODE_ENV=test -e GITHUB_TOKEN=qa-fixture \
  -e DEPENDABOT_QUEUE_THRESHOLD=0 docker.io/library/node:22-alpine node fixture.mjs
```

Five supplementary scenarios were defined and executed through Playwright and the actual HTTP server: all 51 initial PRs passing with comparisons split into 50/1 batches; no new comparisons on unchanged refresh; all 51 flagged four behind after a base push with recorded PR base unchanged; one update sends exactly one empty-body GitHub PUT and moves its PR back to Passing CI; rendered first-party assets return 200 and no page exceptions occur. User/organization queries overlap in the fixture, so cold scans have two 50/1 batch pairs. Automatic refresh was explicitly disabled for deterministic mutation refresh; with it enabled the existing product waits for its scheduled refresh, which exceeded the initial harness's 30-second timeout. This was a harness timing issue, not a changed product requirement.

Evidence: `/tmp/github-monitor-qa-container.json`, `/tmp/github-monitor-qa-container-behind.png`, `/tmp/github-monitor-container-qa.mjs`. All five passed on the final run.

## TDD gate and coverage

`tdd/pr-behind-base.tdd.yaml` validates and is current against its source PRD. Its 36 named scenarios were explicitly selected by ID with `node --test --test-name-pattern` over `test/behind-base.test.js` and `test/behind-base-ui.test.js`; each ref resolved and each runner pass was matched to its full test name. The acceptance scenarios execute the current frontend in a real Chromium page with synthetic API responses. The Podman journey additionally exercises the real server routing and cache. Results: `/tmp/github-monitor-qa-results.json`; per-ID output: `/tmp/github-monitor-qa-tdd.log`.

The existing cache scenario covers unchanged/moved commit identities; the added regression supplies the previously missing realistic stale `baseRefOid` case. Retry-after-partial-response and desktop geometry are additional QA scenarios beyond the original artifact. The unrelated dashboard-contrast artifact was not separately gated, but its tests are included in the full suite.

| Scenario | Level | Priority | Result |
| --- | --- | --- | --- |
| SC-detect-behind-count | unit | P0 | Pass — named test |
| SC-detect-fork-headref | unit | P0 | Pass — named test |
| SC-detect-same-repo-headref | unit | P0 | Pass — named test |
| SC-detect-compare-field | integration | P0 | Pass — named test |
| SC-detect-no-extra-requests | integration | P0 | Pass — named test |
| SC-lane-status-payload | integration | P0 | Pass — named test |
| SC-lane-exclusive | unit | P0 | Pass — named test |
| SC-lane-failing-and-behind | unit | P0 | Pass — named test |
| SC-lane-not-behind-unchanged | unit | P0 | Pass — named test |
| SC-journey-unstick | acceptance | P0 | Pass — named test |
| SC-lane-rail-count | integration | P0 | Pass — named test |
| SC-precedence-conflict-wins | unit | P0 | Pass — named test |
| SC-precedence-no-update-button | integration | P0 | Pass — named test |
| SC-failopen-missing-field | unit | P1 | Pass — named test |
| SC-failopen-bad-values | unit | P1 | Pass — named test |
| SC-endpoint-calls-github | integration | P0 | Pass — named test |
| SC-endpoint-rejects-get | integration | P0 | Pass — named test |
| SC-endpoint-validates-input | integration | P0 | Pass — named test |
| SC-button-present-and-ordered | integration | P0 | Pass — named test |
| SC-button-inflight-single-request | acceptance | P0 | Pass — named test |
| SC-button-success-state | acceptance | P0 | Pass — named test |
| SC-failure-403-message | acceptance | P0 | Pass — named test |
| SC-failure-row-survives | acceptance | P0 | Pass — named test |
| SC-failure-transport-recovers | integration | P0 | Pass — named test |
| SC-notify-stuck-only | integration | P1 | Pass — named test |
| SC-notify-suppressed-when-other-blockers | integration | P1 | Pass — named test |
| SC-notify-no-repeat | integration | P1 | Pass — named test |
| SC-pill-plural-copy | integration | P1 | Pass — named test |
| SC-pill-singular-copy | integration | P1 | Pass — named test |
| SC-pill-long-branch-no-overflow | integration | P1 | Pass — named test |
| SC-actions-merge-available | integration | P1 | Pass — named test |
| SC-actions-merge-blocked-reason | integration | P1 | Pass — named test |
| SC-actions-one-filled-primary | integration | P1 | Pass — named test |
| SC-empty-state-copy | integration | P1 | Pass — named test |
| SC-contrast-tokens-both-themes | unit | P1 | Pass — named test |
| SC-axe-clean-both-themes | acceptance | P1 | Pass — named test |

## Browser and control coverage

Route map: `/` → Out of date / Passing CI / Conflicts via rail; row → Update branch → success/failure → rescan; row Open PR → external GitHub URL. State coverage includes empty, passing/behind, failing/behind, draft, conflict, pending, success, 403, 422, interrupted request, repeated clicks, notification suppression and deduplication. Update branch and rail navigation are clicked; enabled/disabled Merge, Rerun failed, Close and Open PR presence/ordering are inspected. Those additional GitHub mutation workflows are outside this focused journey and were not executed against external services.

First-party link/asset audit: favicon, theme script, stylesheet and application script all returned 200. Synthetic external PR links were intentionally not fetched; their URL values are fixtures, not real resources. No native mobile, email or Stripe flows exist in scope.

Visual specialist reviewed light/dark screenshots at 375×667, 390×844, 430×932, 360×740, 360×800, 768×1024, 1440×900, 1728×1000 and 844×390. Normal viewport matrix has no page overflow; mobile actions meet 44px height. Structural axe and token contrast checks pass. Evidence and specialist report: `/tmp/github-monitor-qa-visual/`. Safari/WebKit, real-device keyboard/safe areas, assistive technology and true browser text zoom remain untested; no WebKit binary is installed. CSS 200% zoom was exploratory only. No performance/security symptoms required a specialist review; neither is claimed as a separate audit.

## Final verification

`npm test`: 302 passed, zero failed/skipped, including browser tests; syntax checks passed. `git diff --check` passed. Feature gate: 36/36 (22 P0, 14 P1; 10 unit, 20 integration, 6 acceptance). Artifact statuses were synced; all were already green, so formatting-only tool changes were discarded. The QA container was stopped and removed (`podman stop github-monitor-qa-outdated`); test browsers closed. The pre-existing user dashboard on port 4177 was untouched by this QA run. No confirmed scoped defects remain unfixed. Screenshots and raw local logs are intentionally excluded from the PR; regression tests are durable evidence.
