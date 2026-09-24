# Running CD freshness QA — 2026-09-24

Scope: the running-CD lane's data source (the repo-wide actions feed, 60s TTL) and the cache invalidation that follows a CD run's state transition. The product is a local GitHub operations dashboard for a repository operator. No production actions were taken: the live instance was read-only, no rerun/merge/close/update-branch or Dependabot cleanup action was invoked, and this product has no email, payment, or notification delivery outside the browser.

## Findings and fixes

- No defects found in the change. The new regression coverage was demonstrated failing against the pre-change server and passing after it (below).
- [#142](https://github.com/ryabinski-labs/github-monitor/issues/142), Medium, visual specialist confirmed: running-CD rows wrap `AM` onto its own line and clamp long titles about 200px short of the status pills while the row sits half empty. Pre-existing, not caused by this backend change; filed with screenshot evidence and a concrete CSS direction so the freshness PR stays scoped.
- Link audit false positive: the only non-200 was `https://github.com/ryabinski-labs/icelandphotomap-api/actions/runs/35738227318`, which returns 404 to anonymous HTML requests because that repository is private. The authenticated API confirms the run exists and the dashboard link is correct. Not a defect.
- The bundled a11y script is blocked by the product's own CSP (`script-src 'self'` rejects its inline axe injection). Axe coverage comes from the repository's suite, which passed in full.

## Environment and evidence

Native live instance (read-only): `PORT=4199`, ETag cache redirected to a temporary path, and `DEPENDABOT_QUEUE_THRESHOLD=0` because the repository-root `.env` opts the server into the Dependabot queue cleanup at startup (`process.loadEnvFile`), and a QA instance must not run that policy a second time against live repositories. Auth: GitHub App. The server's own scan and the headless Chromium session made read-only GETs only.

- First scan 10:11:28Z: 96 repos considered, 37 scanned; the lane held the two live `Deploy` runs on `ryabinski-labs/vectraseo` (`#1303` in_progress, `#1304` pending), matching `gh api /repos/…/actions/runs` exactly.
- Live transition: `#1303` completed at 10:21:01Z on GitHub. The 10:20:11Z scan still showed it running; the 10:23:51Z scan had left Running CD and landed in Finished CD (`landedInFinished: true`) within the dashboard's 180s refresh cadence. No console errors, page errors, or failed requests in the session.
- Screenshots: desktop dashboard, running-CD lane, and post-transition lane (throwaway artifacts under `/tmp/qa-cd-freshness/`).

Containerized E2E (Podman 6.0.2, `node:22-alpine`, synthetic GitHub transport, `.cache/qa-cd-freshness`, local URL `http://127.0.0.1:4180`) — seven steps, all pass, no console errors or failed requests:

1. the actions feed was fetched on the first scan (`feed=1, heavy=1, workflows=1`);
2. a live run the enriched cache had fetched as absent still shows in Running CD;
3. a progress tick (`updated_at` moves, state unchanged) does not reset the enriched cache (`heavy` stays 1);
4. the live run survives the tick;
5. the completion transition drops the enriched cache (`heavy=2, workflows=2`);
6. the completed run leaves Running CD;
7. the same scan rebuilds it into Finished CD as a `SUCCESS` row.

One fixture defect was found and fixed during the run: the synthetic workflow lacked `state: "active"`, so `fetchCdWorkflows` filtered it out and no enriched fetch happened. A harness bug, not product behavior; the rerun is fully green. Evidence: `/tmp/qa-cd-freshness/container/results.json` and its before/after screenshots.

## Regression coverage and red phase

- `test/cd-running-freshness.test.js` (new, 9 tests) covers the merge, the fingerprint, and four integration assertions through the real `/api/status` with a mocked GitHub: a feed-only run appears while the enriched cache is stale; a feed-completed run is demoted out of the running lane without a refetch; a progress tick does not refetch; a transition forces a refetch that rebuilds the finished lane in the same pass.
- Red phase: the four integration assertions were rebuilt against a `git worktree` of base commit `35683f4` (pre-change server) and all four fail there; all nine pass on the change.
- Full suite on the change: 311 tests and `npm run check` pass. The `test/scan-latency.test.js` comment was updated for the new source of running state; its staleness-ceiling assertion still holds.

## TDD gate and coverage

No TDD artifact covers this feature. The two existing artifacts (`tdd/dashboard-contrast.tdd.yaml`, `tdd/pr-behind-base.tdd.yaml`) target other features; their tests ran inside the 311-test suite but were not separately gated, matching the prior QA report's treatment.

## Areas not tested and blockers

- Safari/WebKit is unavailable on this setup; Chromium only.
- Destructive dashboard actions (rerun, merge, close, update branch, Dependabot cleanup) were not exercised against live repositories — out of scope for a read-only freshness run.
- Visual quality was delegated to `visual-qa-agent`; its confirmed findings are filed as #142.
