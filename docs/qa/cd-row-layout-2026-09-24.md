# CD row layout QA — 2026-09-24

Scope: the Running / Finished / Failed CD row rendering fixed for issue #142 — the branch-and-time meta orphan, the starved title column, and the raw `in_progress` enum. Read-only live instance and a synthetic browser pass; no destructive dashboard action was exercised.

## Findings and fixes

- No defects in the shipped change. Five of the six new browser scenarios fail against the pre-fix `app.js` / `styles.css` and all six pass after; the sixth (mobile containment) was already green and stays green as a non-regression.
- One design finding during QA: the first cut capped the branch-and-time track at 220px, which clipped the Failed CD row's combined `Reason: … · branch · time` meta and hid the timestamp (live evidence, the `Sendant` failed row). Fixed before shipping by giving failed rows a wider variant track (`row-cd-detail`, 320px cap) and a `title` tooltip on the detail meta; re-verified live.
- One harness race, not a product defect: a live capture measured the finished lane mid-re-render (0 rows) while `/api/status` returned 100; the immediate re-run measured 100.

## Environment and evidence

- Synthetic browser pass (Playwright Chromium; page assembled from `public/` exactly as the UI tests do), 1440x900 dark and light plus 390x844: `/tmp/qa-142/desktop-running-cd.png`, `desktop-finished-cd.png`, `desktop-failed-cd.png`, `mobile-running-cd.png`. The running rows read `PENDING` / `IN PROGRESS` with `main · Sep 24, 2:06 AM` on one line; the failed row reads its full reason and time.
- Live read-only instance (`:4199`, `DEPENDABOT_QUEUE_THRESHOLD=0` so the repo-root `.env` policy is not run twice, ETag cache redirected to a temp path, GitHub App auth): the finished lane rendered 100 rows with a 610px title, 55px run-number meta and a single-line time meta; the one failed row showed `Reason: testflight failed · main · Sep 24, 5:57 AM` on one line at 320px. 0 console errors, 0 page errors, 0 failed requests. Screenshots `live-finishedCd.png`, `live-failedCd.png`.
- The live running lane was empty (no CD workflow running at the time), so the running-row evidence is the synthetic pass; both go through the same `renderCdRow` path.

## Regression coverage and red phase

- `test/cd-row-layout-ui.test.js` (new, 6 scenarios): the running row keeps its branch-and-time meta on one line at 1440px; the title out-earns both metas while `Deploy #1304` sits at ≤140px; running statuses read `Pending` / `In progress`; the finished row keeps its meta on one line and its title in the flexible track; the failed row keeps reason and time on one line on the wider track; a 390px viewport contains the row with no horizontal scroll.
- Red phase: with `public/app.js` and `public/styles.css` stashed back to the base, five scenarios fail for the issue's exact symptoms (`meta heights 13px and 26px`, `Deploy #1304` stretched to 400px, `in_progress` raw enum, finished/failed equivalents); all six pass with the fix.
- Full suite on the change: 317 tests + `npm run check` pass.

## TDD gate and coverage

No TDD artifact covers this render-layer change. The two existing artifacts (`tdd/dashboard-contrast.tdd.yaml`, `tdd/pr-behind-base.tdd.yaml`) target other features; their tests ran inside the full suite.

## Areas not tested and blockers

- Safari / WebKit is unavailable on this setup; Chromium only.
- No live running CD row was observed during the pass (none was running); covered synthetically.
- Destructive dashboard actions (rerun, merge, close, Dependabot cleanup) were not exercised; out of scope for a layout fix.
- Issues #126, #135 and #136 were already fixed on `main` by merged PRs (#131, #137) and are closed with their test evidence rather than re-fixed here.
