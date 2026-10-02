// Spot runners get reclaimed mid-build and the run fails through no fault of the
// change. Auto rerun retries a fresh failure once; a run that fails again after
// that retry is not retried a second time but marked `exhausted` so the
// dashboard can alert on it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateDir = mkdtempSync(path.join(tmpdir(), "auto-rerun-"));
const statePath = path.join(stateDir, "auto-rerun.json");
process.env.AUTO_RERUN_STATE_PATH = statePath;
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";
process.env.GITHUB_TOKEN = "test-token";
process.env.ETAG_CACHE_DISABLED = "1";

const {
  server,
  autoRerunState,
  autoRerunDecision,
  applyAutoRerun,
  loadAutoRerunStateFromDisk,
  AUTO_RERUN_MAX_AGE_MS
} = await import("../server.js");

const realFetch = globalThis.fetch;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const recent = new Date(NOW - 10 * 60 * 1000).toISOString();

test.after(() => rmSync(stateDir, { recursive: true, force: true }));
test.afterEach(() => {
  globalThis.fetch = realFetch;
  autoRerunState.enabled = false;
  autoRerunState.requested.clear();
  autoRerunState.lastError = "";
});

// Records every GitHub call; GET of a run answers from `runs`.
function mockGithub(runs = {}, { rerunStatus = 201 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method || "GET";
    calls.push(`${method} ${pathname}`);
    if (pathname.endsWith("/rerun-failed-jobs")) {
      return rerunStatus < 300
        ? new Response(null, { status: rerunStatus })
        : Response.json({ message: "Unable to rerun" }, { status: rerunStatus });
    }
    const match = pathname.match(/\/actions\/runs\/(\d+)$/);
    if (match && runs[match[1]]) return Response.json(runs[match[1]]);
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return calls;
}

function failedRun(overrides = {}) {
  return {
    kind: "workflowRun",
    runId: 501,
    repo: "acme/api",
    workflow: "CI",
    runNumber: "#9",
    status: "completed",
    conclusion: "failure",
    createdAt: recent,
    runAttempt: 1,
    url: "https://github.com/acme/api/actions/runs/501",
    ...overrides
  };
}

test("the policy reruns a fresh first attempt and marks a failed retry exhausted", () => {
  assert.equal(autoRerunDecision(failedRun(), { now: NOW }), "rerun");
  assert.equal(autoRerunDecision(failedRun({ conclusion: "timed_out" }), { now: NOW }), "rerun");
  assert.equal(autoRerunDecision(failedRun({ runAttempt: 2 }), { now: NOW }), "exhausted");
  assert.equal(autoRerunDecision(failedRun({ runAttempt: 3 }), { now: NOW }), "exhausted");
});

test("the policy leaves cancelled, broken-workflow, old and unfinished runs alone", () => {
  assert.equal(autoRerunDecision(failedRun({ conclusion: "cancelled" }), { now: NOW }), null);
  assert.equal(autoRerunDecision(failedRun({ conclusion: "startup_failure" }), { now: NOW }), null);
  assert.equal(autoRerunDecision(failedRun({ status: "in_progress" }), { now: NOW }), null);
  const old = new Date(NOW - AUTO_RERUN_MAX_AGE_MS - 1000).toISOString();
  assert.equal(autoRerunDecision(failedRun({ createdAt: old }), { now: NOW }), null);
  assert.equal(autoRerunDecision(failedRun({ runAttempt: 2, createdAt: old }), { now: NOW }), null);
});

test("off by default: nothing is rerun and rows are untouched", async () => {
  const calls = mockGithub();
  const rows = [failedRun()];
  const result = await applyAutoRerun({ failedActions: rows }, { now: NOW });
  assert.equal(result.failedActions, rows);
  assert.deepEqual(calls, []);
});

test("a first-attempt failure is rerun exactly once across scans", async () => {
  autoRerunState.enabled = true;
  const calls = mockGithub();
  const first = await applyAutoRerun({ failedActions: [failedRun()] }, { now: NOW });
  assert.deepEqual(first.failedActions[0].autoRerun, { state: "requested", attempt: 2 });
  // GitHub has not flipped the run to queued yet; the next scan sees it failed.
  const second = await applyAutoRerun({ failedActions: [failedRun()] }, { now: NOW + 30_000 });
  assert.deepEqual(second.failedActions[0].autoRerun, { state: "requested", attempt: 2 });
  assert.deepEqual(calls, ["POST /repos/acme/api/actions/runs/501/rerun-failed-jobs"]);
});

test("a failure on the rerun attempt is exhausted, not retried", async () => {
  autoRerunState.enabled = true;
  const calls = mockGithub();
  const result = await applyAutoRerun({ failedCd: [failedRun({ runAttempt: 2, workflow: "Deploy" })] }, { now: NOW });
  assert.deepEqual(result.failedCd[0].autoRerun, { state: "exhausted", attempt: 2 });
  assert.deepEqual(calls, []);
});

test("auto-dismissed rows are never rerun", async () => {
  autoRerunState.enabled = true;
  const calls = mockGithub();
  const result = await applyAutoRerun({ failedActions: [failedRun({ autoDismissed: true })] }, { now: NOW });
  assert.equal(result.failedActions[0].autoRerun, undefined);
  assert.deepEqual(calls, []);
});

test("a refused rerun is reported once and not retried every scan", async () => {
  autoRerunState.enabled = true;
  const calls = mockGithub({}, { rerunStatus: 403 });
  // Its own run id: the click-and-auto dedup shared with the Rerun button
  // still remembers run 501 from the tests above.
  const refused = () => failedRun({ runId: 777 });
  const first = await applyAutoRerun({ failedActions: [refused()] }, { now: NOW });
  assert.equal(first.failedActions[0].autoRerun.state, "error");
  const second = await applyAutoRerun({ failedActions: [refused()] }, { now: NOW + 30_000 });
  assert.equal(second.failedActions[0].autoRerun.state, "error");
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  assert.match(autoRerunState.lastError, /acme\/api run 777/);
});

test("PR failures look up the run's attempt, rerun once, and roll the worst state up", async () => {
  autoRerunState.enabled = true;
  const calls = mockGithub({
    601: { status: "completed", conclusion: "failure", run_attempt: 1, updated_at: recent },
    602: { status: "completed", conclusion: "failure", run_attempt: 2, updated_at: recent }
  });
  const pr = {
    repo: "acme/store",
    number: 7,
    state: "fail",
    failedRuns: [
      { runId: 601, workflow: "Unit", url: "" },
      { runId: 602, workflow: "Browser", url: "" }
    ]
  };
  const { pullRequests } = await applyAutoRerun({ pullRequests: [pr, { repo: "acme/store", number: 8, state: "pass" }] }, { now: NOW });
  assert.deepEqual(pullRequests[0].failedRuns[0].autoRerun, { state: "requested", attempt: 2 });
  assert.deepEqual(pullRequests[0].failedRuns[1].autoRerun, { state: "exhausted", attempt: 2 });
  assert.equal(pullRequests[0].autoRerun.state, "exhausted");
  assert.equal(pullRequests[1].autoRerun, undefined);
  assert.deepEqual(calls.sort(), [
    "GET /repos/acme/store/actions/runs/601",
    "GET /repos/acme/store/actions/runs/602",
    "POST /repos/acme/store/actions/runs/601/rerun-failed-jobs"
  ]);
});

test("/api/auto-rerun reads and saves the server-side switch", async () => {
  const listener = await new Promise((resolve) => {
    const started = server.listen(0, "127.0.0.1", () => resolve(started));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    const initial = await (await realFetch(`${base}/api/auto-rerun`)).json();
    assert.equal(initial.enabled, false);
    const saved = await realFetch(`${base}/api/auto-rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal((await saved.json()).enabled, true);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).enabled, true);
    autoRerunState.enabled = false;
    assert.equal(loadAutoRerunStateFromDisk(statePath), true);
    assert.equal(autoRerunState.enabled, true);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});
