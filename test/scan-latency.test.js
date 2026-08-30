import test from "node:test";
import assert from "node:assert/strict";
import {
  settledScanPass,
  parseJobs,
  DEFAULT_SCAN_JOBS,
  MAX_SCAN_JOBS,
  GITHUB_REQUEST_TIMEOUT_MS,
  SCAN_PASS_DEADLINE_MS,
  WORKFLOW_RUN_CACHE_TTL_MS
} from "../server.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A wedged item is the point of the deadline test, but its timer must not keep
// the runner alive for its full duration after the assertion has passed.
const wedge = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

// --- settledScanPass: a pass degrades instead of failing whole -----------------

test("a repo that throws yields its empty shape and does not sink the pass", async () => {
  const { results, failed } = await settledScanPass(
    ["a", "b", "c"],
    4,
    async (repo) => {
      if (repo === "b") throw new Error("502 from GitHub");
      return { repo };
    },
    () => ({ repo: null })
  );

  assert.equal(failed, true, "the pass reports that something did not finish");
  assert.deepEqual(results, [{ repo: "a" }, { repo: null }, { repo: "c" }]);
});

test("a clean pass reports failed:false and preserves input order", async () => {
  // Deliberately finish out of order: the slowest item is first, so a result
  // array built by completion order rather than index would come back reversed.
  const { results, failed } = await settledScanPass(
    [30, 20, 1],
    3,
    async (ms) => {
      await sleep(ms);
      return ms;
    },
    () => null
  );

  assert.equal(failed, false);
  assert.deepEqual(results, [30, 20, 1], "results stay aligned to their input index");
});

test("a pass past its deadline returns what it has, flagged, instead of hanging", async () => {
  const started = Date.now();
  const { results, failed } = await settledScanPass(
    ["fast", "wedged"],
    1,
    async (repo) => {
      if (repo === "wedged") await wedge(60_000);
      return repo;
    },
    () => null,
    150
  );
  const elapsed = Date.now() - started;

  assert.equal(failed, true, "blowing the deadline marks the section degraded");
  assert.equal(results[0], "fast", "work already finished is kept");
  assert.equal(results[1], null, "unfinished work falls back to the empty shape");
  assert.ok(elapsed < 5_000, `returned in ${elapsed}ms rather than waiting on the wedged item`);
});

test("a deadline of 0 disables the ceiling rather than expiring instantly", async () => {
  const { results, failed } = await settledScanPass(
    ["a"],
    1,
    async (repo) => {
      await sleep(20);
      return repo;
    },
    () => null,
    0
  );

  assert.equal(failed, false);
  assert.deepEqual(results, ["a"]);
});

test("an empty item list is a clean pass, not a degraded one", async () => {
  const { results, failed } = await settledScanPass([], 4, async () => "x", () => null);
  assert.equal(failed, false);
  assert.deepEqual(results, []);
});

// --- concurrency defaults -----------------------------------------------------

test("the default scan concurrency is the raised one, not the old 4", async () => {
  assert.equal(DEFAULT_SCAN_JOBS, 8, "the shipped default, independent of any local .env");
});

test("an unset OPEN_PRS_JOBS falls back to the default", async () => {
  // parseJobs reads process.env at call time, so a developer's .env (this repo
  // ships OPEN_PRS_JOBS=16) would otherwise decide what this asserts. Drive the
  // variable explicitly rather than assuming a clean environment.
  const previous = process.env.OPEN_PRS_JOBS;
  delete process.env.OPEN_PRS_JOBS;
  try {
    assert.equal(parseJobs(null), DEFAULT_SCAN_JOBS);
    assert.equal(parseJobs(""), DEFAULT_SCAN_JOBS);
  } finally {
    if (previous === undefined) delete process.env.OPEN_PRS_JOBS;
    else process.env.OPEN_PRS_JOBS = previous;
  }
});

test("OPEN_PRS_JOBS overrides the default but stays under the cap", async () => {
  const previous = process.env.OPEN_PRS_JOBS;
  try {
    process.env.OPEN_PRS_JOBS = "12";
    assert.equal(parseJobs(null), 12);
    process.env.OPEN_PRS_JOBS = "999";
    assert.equal(parseJobs(null), MAX_SCAN_JOBS);
  } finally {
    if (previous === undefined) delete process.env.OPEN_PRS_JOBS;
    else process.env.OPEN_PRS_JOBS = previous;
  }
});

test("an explicit jobs value is honoured, and nonsense falls back to the default", async () => {
  const previous = process.env.OPEN_PRS_JOBS;
  delete process.env.OPEN_PRS_JOBS;
  try {
    assert.equal(parseJobs("12"), 12);
    assert.equal(parseJobs("1"), 1);
    assert.equal(parseJobs("0"), DEFAULT_SCAN_JOBS, "0 lanes would stall the scan");
    assert.equal(parseJobs("-3"), DEFAULT_SCAN_JOBS);
    assert.equal(parseJobs("banana"), DEFAULT_SCAN_JOBS);
    assert.equal(parseJobs("2.5"), DEFAULT_SCAN_JOBS, "a fractional lane count is not a lane count");
  } finally {
    if (previous === undefined) delete process.env.OPEN_PRS_JOBS;
    else process.env.OPEN_PRS_JOBS = previous;
  }
});

test("jobs stays capped so a caller cannot fan out into the secondary rate limit", async () => {
  assert.equal(parseJobs("99"), MAX_SCAN_JOBS);
  assert.equal(parseJobs(String(MAX_SCAN_JOBS + 1)), MAX_SCAN_JOBS);
});

// --- request timeout ----------------------------------------------------------

test("every GitHub request is bounded, so a stalled socket cannot wedge a lane forever", async () => {
  assert.ok(Number.isFinite(GITHUB_REQUEST_TIMEOUT_MS), "the timeout resolves to a real number");
  assert.ok(GITHUB_REQUEST_TIMEOUT_MS >= 1000, "a sub-second cap would abort healthy requests");
  assert.ok(GITHUB_REQUEST_TIMEOUT_MS <= 120_000, "a cap this side of two minutes still bounds a hang");
});

test("a scan pass ceiling exists and sits above a single request's timeout", async () => {
  assert.ok(SCAN_PASS_DEADLINE_MS > 0, "the pass ceiling is enabled by default");
  assert.ok(
    SCAN_PASS_DEADLINE_MS >= GITHUB_REQUEST_TIMEOUT_MS,
    "a pass must outlive one request, or it would cut off work that was about to succeed"
  );
});

// --- CD workflow-run cache TTL ------------------------------------------------

test("the workflow-run cache outlives a whole scan pass, or it never gets reused", async () => {
  // The bug this guards: at 60s, entries fetched at the start of a ~320s CD pass
  // had expired before the pass finished, so consecutive passes shared nothing
  // and the cache did no work at all. Surviving one pass is the minimum bar.
  assert.ok(
    WORKFLOW_RUN_CACHE_TTL_MS > SCAN_PASS_DEADLINE_MS,
    `TTL ${WORKFLOW_RUN_CACHE_TTL_MS}ms must exceed the pass deadline ${SCAN_PASS_DEADLINE_MS}ms`
  );
});

test("the workflow-run TTL stays inside a sane staleness ceiling", async () => {
  // It defers CD runs started outside the dashboard, so it buys reuse without
  // letting the CD panel drift arbitrarily far from GitHub.
  assert.ok(Number.isFinite(WORKFLOW_RUN_CACHE_TTL_MS));
  assert.ok(
    WORKFLOW_RUN_CACHE_TTL_MS <= 30 * 60 * 1000,
    "half an hour of stale CD state is past useful"
  );
});

test("a cold scan pass is given room to finish rather than guillotined", async () => {
  // Measured on an 85-repo account: allowed to run, the cold cd/deployments
  // passes take ~72s and return 122 CD rows. At the old 60s ceiling they were
  // cut off at 102 rows and marked degraded on every cold boot -- a complete
  // answer sacrificed for about twelve seconds. The ceiling still exists to stop
  // a pathological pass, so this is a floor on the headroom, not a removal.
  assert.ok(
    SCAN_PASS_DEADLINE_MS >= 120_000,
    `${SCAN_PASS_DEADLINE_MS}ms leaves a cold pass no margin over the ~72s it measures`
  );
});
