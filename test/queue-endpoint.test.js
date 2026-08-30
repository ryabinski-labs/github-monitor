import test from "node:test";
import assert from "node:assert/strict";
import {
  queueRepoNames,
  toQueuedRun,
  quotaSnapshot,
  selectActiveRepos,
  QUEUE_RUN_STATUSES,
  QUEUE_PASS_DEADLINE_MS,
  QUEUE_REQUEST_BUDGET_MS,
  withQueueDeadline,
  queuePassDeadline,
  settledScanPass,
  QUEUE_MAX_PAGES,
  QUEUE_PAGE_SIZE
} from "../server.js";

const HOUR = 60 * 60 * 1000;

// --- the freshness bypass, which is the whole reason /api/queue exists --------

test("the queue repo list keeps a repo the dashboard scan trims away", async () => {
  // The defect, concretely: a repo nobody has pushed to in three weeks can still
  // have a scheduled run, a workflow_dispatch, or a re-run sitting queued. The
  // dashboard trims it to save requests, which is fine for a dashboard and fatal
  // for an autoscaler -- it reads "no demand" and scales to zero with work
  // waiting. Same candidates in; the two functions must disagree.
  const now = Date.parse("2026-08-30T12:00:00Z");
  const candidates = [
    { fullName: "acme/busy", pushedAt: new Date(now - 2 * HOUR).toISOString() },
    { fullName: "acme/quiet", pushedAt: new Date(now - 21 * 24 * HOUR).toISOString() }
  ];

  const scanned = selectActiveRepos(candidates, { withinMs: 168 * HOUR, floor: 0, now });
  assert.deepEqual(scanned, ["acme/busy"], "the dashboard scan drops the quiet repo");

  assert.deepEqual(
    queueRepoNames(candidates),
    ["acme/busy", "acme/quiet"],
    "the queue scan must keep it, or queued work on it is invisible"
  );
});

test("the queue repo list dedups and sorts, and tolerates bare strings", async () => {
  assert.deepEqual(
    queueRepoNames([{ fullName: "b/two" }, "a/one", { fullName: "b/two" }, null, { fullName: "" }]),
    ["a/one", "b/two"]
  );
  assert.deepEqual(queueRepoNames(null), []);
});

// --- the run shape the autoscaler maps ---------------------------------------

test("a queued run carries exactly the fields the consumer reads, under the same names", async () => {
  // These names are a contract with ci_queue_autoscale.py, which reads them off
  // status.actions.running[] today. Renaming one here silently breaks its
  // mapping layer rather than failing loudly, so the list is pinned.
  const run = toQueuedRun(
    {
      id: 4242,
      created_at: "2026-08-30T11:00:00Z",
      name: "Nightly",
      run_number: 88,
      status: "queued",
      head_branch: "main",
      event: "schedule",
      display_title: "Nightly sweep",
      html_url: "https://github.com/acme/quiet/actions/runs/4242"
    },
    "acme/quiet"
  );

  for (const field of ["repo", "runId", "workflow", "runNumber", "branch", "status", "createdAt", "url"]) {
    assert.ok(field in run, `${field} is part of the published contract`);
  }
  assert.equal(run.repo, "acme/quiet");
  assert.equal(run.runId, 4242);
  assert.equal(run.workflow, "Nightly");
  assert.equal(run.runNumber, "#88", "the # prefix matches actions.running[], so no second format to parse");
  assert.equal(run.status, "queued");
  assert.equal(run.branch, "main");
  assert.equal(run.createdAt, "2026-08-30T11:00:00Z");
  assert.equal(run.event, "schedule", "the trigger that the freshness trim was hiding");
  assert.equal(run.autoDismissed, undefined, "absent, not false: a plain run is not dismissed");
});

test("a sparse run degrades to empty strings rather than undefined", async () => {
  // A consumer lowercases .status and string-matches it. undefined.toLowerCase()
  // throws in its process, not ours, which makes it our bug to prevent.
  const run = toQueuedRun({ run_number: 1 }, "acme/thin");
  assert.equal(run.status, "");
  assert.equal(run.branch, "");
  assert.equal(run.createdAt, "");
  assert.equal(run.url, "");
  assert.equal(run.workflow, "Workflow");
  assert.ok(!("runId" in run), "an id-less run omits runId so dedup falls through to url");
});

test("a Dependabot run is flagged so cleanup's dismissal can be applied to it", async () => {
  const run = toQueuedRun(
    { run_number: 3, actor: { login: "dependabot[bot]" } },
    "acme/deps"
  );
  assert.equal(run.dependabot, true);
});

// --- the demand set ----------------------------------------------------------

test("only `queued` counts as runner demand", async () => {
  // waiting/requested/pending mean a run is held by a deployment gate, an
  // approval, or a concurrency group. Starting a runner releases none of them,
  // so counting them would over-provision -- the same reason a queued deployment
  // is not runner demand either.
  assert.deepEqual(QUEUE_RUN_STATUSES, ["queued"]);
});

// --- latency budget ----------------------------------------------------------

test("the queue pass gives up well inside the consumer's hard ceiling", async () => {
  // The autoscaler's ceiling is 30s and its target p95 is 10s. A pass allowed to
  // run to the dashboard's own deadline would return after the client had given
  // up, so the answer would be complete and unread. Degraded and on time wins.
  assert.ok(QUEUE_PASS_DEADLINE_MS <= 30_000, `${QUEUE_PASS_DEADLINE_MS}ms would blow the 30s ceiling`);
  assert.ok(QUEUE_PASS_DEADLINE_MS >= 1_000, "a sub-second pass would degrade on every call");
});

test("per-repo pagination stays bounded", async () => {
  // A repo past this is a Dependabot storm, not a capacity signal; it is named in
  // queue.truncatedRepos and marked degraded rather than paginated forever inside
  // a request with a ten-second budget.
  assert.ok(QUEUE_MAX_PAGES >= 1 && QUEUE_MAX_PAGES <= 10);
  assert.equal(QUEUE_PAGE_SIZE, 100, "GitHub's max page size, so the cap costs the fewest requests");
});

// --- the quota block the consumer backs off on -------------------------------

test("quotaSnapshot publishes blocked and retryAfterSeconds at the path /api/status already uses", async () => {
  // The consumer backs off on refresh.quota.blocked today. Polling a second
  // endpoint must not mean learning a second field layout.
  const snapshot = quotaSnapshot({
    tightest: { resource: "core", remaining: 0, limit: 5000, resetAt: new Date(Date.now() + 60_000).toISOString() }
  });
  assert.equal(snapshot.blocked, true);
  assert.equal(snapshot.status, "exhausted");
  assert.equal(snapshot.resource, "core");
  assert.equal(snapshot.remaining, 0);
  assert.equal(snapshot.limit, 5000);
  assert.ok(snapshot.retryAfterSeconds > 0, "a blocked consumer needs to know how long to wait");
});

test("quotaSnapshot with no observed rate limit is not reported as blocked", async () => {
  // No data is not evidence of exhaustion. Reporting blocked here would stall an
  // autoscaler on a cold server that has simply not called GitHub yet.
  const snapshot = quotaSnapshot({});
  assert.equal(snapshot.blocked, false);
  assert.equal(snapshot.status, "unknown");
  assert.equal(snapshot.retryAfterSeconds, 0);
});

// --- the whole-request budget ------------------------------------------------
//
// QUEUE_PASS_DEADLINE_MS bounds the repo fan-out and nothing else. Account
// lookup, the mode=mine PR search and owner listing all run ahead of it, so
// before this budget existed the endpoint's real worst case was unbounded -- and
// a cold request had already been measured at 23.3s against a consumer whose
// hard ceiling is 30s.

test("the request budget sits under the consumer's hard ceiling", async () => {
  assert.ok(
    QUEUE_REQUEST_BUDGET_MS <= 30_000,
    `${QUEUE_REQUEST_BUDGET_MS}ms would return after the consumer's 30s ceiling, so nobody would read it`
  );
  assert.ok(QUEUE_REQUEST_BUDGET_MS >= 5_000, "a budget this tight would degrade healthy requests");
});

test("the request budget strictly outlives the fan-out deadline", async () => {
  // Otherwise the budget strangles the pass before the pass's own ceiling can
  // ever apply, and two deadlines end up fighting over the same work.
  assert.ok(
    QUEUE_REQUEST_BUDGET_MS > QUEUE_PASS_DEADLINE_MS,
    `budget ${QUEUE_REQUEST_BUDGET_MS}ms must exceed pass deadline ${QUEUE_PASS_DEADLINE_MS}ms`
  );
});

test("an exhausted budget yields null, never a deadline of 0", async () => {
  // The inversion this guards, proven in two halves. First: settledScanPass reads
  // 0 as "no ceiling at all" -- a wedged item runs unbounded.
  const started = Date.now();
  const wedged = await settledScanPass(
    ["a"],
    1,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "done";
    },
    () => null,
    0
  );
  assert.equal(wedged.failed, false, "a 0 deadline imposes no ceiling, it does not expire instantly");
  assert.ok(Date.now() - started >= 35, "the work ran to completion rather than being cut off");

  // Second: so an exhausted budget must never reach it as a number. Math.min
  // alone would hand through 0 and negatives and lift the bound at exactly the
  // moment the bound is the point.
  assert.equal(queuePassDeadline(0), null);
  assert.equal(queuePassDeadline(-1_000), null);
});

test("the pass gets whichever ceiling arrives first", async () => {
  assert.equal(queuePassDeadline(5_000, 20_000), 5_000, "a short remaining budget wins");
  assert.equal(queuePassDeadline(60_000, 20_000), 20_000, "otherwise the pass deadline stands");
  assert.equal(queuePassDeadline(1, 20_000), 1, "a millisecond is still a budget, not an absence of one");
});

test("a phase that beats the clock returns its value untouched", async () => {
  const outcome = await withQueueDeadline(Promise.resolve(["acme/one"]), 5_000, []);
  assert.deepEqual(outcome, { value: ["acme/one"], timedOut: false });
});

test("a phase that blows the clock returns the fallback promptly, flagged", async () => {
  const started = Date.now();
  const slow = new Promise((resolve) => setTimeout(resolve, 30_000).unref());
  const outcome = await withQueueDeadline(slow, 60, "fallback");
  const elapsed = Date.now() - started;

  assert.equal(outcome.timedOut, true, "the caller must be able to tell the answer is short");
  assert.equal(outcome.value, "fallback");
  assert.ok(elapsed < 3_000, `returned in ${elapsed}ms rather than waiting on the slow phase`);
});

test("no remaining budget short-circuits without starting a timer", async () => {
  for (const remaining of [0, -5_000]) {
    const outcome = await withQueueDeadline(Promise.resolve("late"), remaining, "fallback");
    assert.deepEqual(outcome, { value: "fallback", timedOut: true }, `remaining=${remaining}`);
  }
});

test("a phase that fails before the clock still throws", async () => {
  await assert.rejects(
    () => withQueueDeadline(Promise.reject(new Error("403 from GitHub")), 5_000, []),
    /403 from GitHub/,
    "a real failure must not be laundered into a silent fallback"
  );
});

test("a phase that fails after losing the race cannot crash the process", async () => {
  // The response has already been sent by then. An orphaned rejection surfacing
  // as an unhandled rejection would take the server down for a request that
  // succeeded, so the rejection is carried as a value and dropped.
  let unhandled = null;
  const capture = (error) => { unhandled = error; };
  process.on("unhandledRejection", capture);
  try {
    const doomed = new Promise((_, reject) => setTimeout(() => reject(new Error("late 500")), 40).unref());
    const outcome = await withQueueDeadline(doomed, 10, "fallback");
    assert.equal(outcome.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(unhandled, null, `the orphaned rejection escaped: ${unhandled?.message}`);
  } finally {
    process.off("unhandledRejection", capture);
  }
});
