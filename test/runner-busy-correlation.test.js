import test from "node:test";
import assert from "node:assert/strict";

import { attachBusyRunnerJobs } from "../server.js";

// The runners API reports that a runner is busy but never says since when, so
// attachBusyRunnerJobs recovers the missing start from the jobs of the runs the
// dashboard already fetched. These tests drive that correlation directly: the
// browser tests cover what the client does with a startedAt, not how one is found.

function busyRunner(name, level = "ORG", scope = "acme") {
  return { level, scope, name, status: "online", labels: ["self-hosted"] };
}

function runRow(repo, runId) {
  return { repo, runId, url: `https://github.com/${repo}/actions/runs/${runId}` };
}

// Stubs the one call attachBusyRunnerJobs makes -- GET .../runs/<id>/jobs -- and
// records the paths so a test can assert how much quota the correlation spends.
async function withJobsApi(byRun, run) {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const requested = [];

  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    requested.push(pathname);
    const match = pathname.match(/^\/repos\/(.+)\/actions\/runs\/(\d+)\/jobs$/);
    const entry = match ? byRun[`${match[1]}#${match[2]}`] : undefined;
    if (entry === "error") {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ jobs: entry || [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    return { result: await run(), requested };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
}

test("a busy runner takes the start time of the in-progress job assigned to it", async () => {
  const { result } = await withJobsApi(
    {
      "acme/app#1": [
        { name: "build", status: "in_progress", runner_name: "runner-1", started_at: "2026-01-01T10:00:00Z", html_url: "https://github.com/acme/app/runs/11" },
        { name: "lint", status: "completed", runner_name: "runner-2", started_at: "2026-01-01T09:00:00Z" }
      ]
    },
    () => attachBusyRunnerJobs([busyRunner("runner-1"), busyRunner("runner-2")], [runRow("acme/app", 1)], 4)
  );

  const [first, second] = result;
  assert.equal(first.startedAt, "2026-01-01T10:00:00Z");
  assert.equal(first.jobName, "build");
  assert.equal(first.jobRepo, "acme/app");
  assert.equal(first.url, "https://github.com/acme/app/runs/11");

  // runner-2's only job has finished, so nothing is claiming it: a completed job
  // must not hand the runner a start time it is no longer working on.
  assert.equal(second.startedAt, undefined);
  assert.equal(second.jobName, undefined);
});

test("when two runs both claim a runner the earlier start wins", async () => {
  const { result } = await withJobsApi(
    {
      "acme/app#1": [
        { name: "late", status: "in_progress", runner_name: "runner-1", started_at: "2026-01-01T12:00:00Z" }
      ],
      "acme/app#2": [
        { name: "early", status: "in_progress", runner_name: "runner-1", started_at: "2026-01-01T11:00:00Z" }
      ]
    },
    () => attachBusyRunnerJobs([busyRunner("runner-1")], [runRow("acme/app", 1), runRow("acme/app", 2)], 4)
  );

  // A runner executes one job at a time, so the earlier start is the one actually
  // holding it -- the other is a record the API has not caught up with.
  assert.equal(result[0].startedAt, "2026-01-01T11:00:00Z");
  assert.equal(result[0].jobName, "early");
});

test("one unreadable run does not cost the other runners their start times", async () => {
  const { result } = await withJobsApi(
    {
      "acme/app#1": "error",
      "acme/app#2": [
        { name: "build", status: "in_progress", runner_name: "runner-2", started_at: "2026-01-01T10:00:00Z" }
      ]
    },
    () => attachBusyRunnerJobs([busyRunner("runner-1"), busyRunner("runner-2")], [runRow("acme/app", 1), runRow("acme/app", 2)], 4)
  );

  assert.equal(result[0].startedAt, undefined);
  assert.equal(result[1].startedAt, "2026-01-01T10:00:00Z");
});

test("correlation costs one request per distinct run and none with no busy runners", async () => {
  const runs = [runRow("acme/app", 1), runRow("acme/app", 1), runRow("acme/app", 2)];

  const { requested } = await withJobsApi(
    { "acme/app#1": [], "acme/app#2": [] },
    () => attachBusyRunnerJobs([busyRunner("runner-1")], runs, 4)
  );
  // The duplicate run is collapsed: quota scales with work in flight, not rows.
  assert.deepEqual(requested.sort(), [
    "/repos/acme/app/actions/runs/1/jobs",
    "/repos/acme/app/actions/runs/2/jobs"
  ]);

  const idle = await withJobsApi({ "acme/app#1": [] }, () => attachBusyRunnerJobs([], runs, 4));
  assert.deepEqual(idle.requested, []);
  assert.deepEqual(idle.result, []);
});

test("runs without an id or repo are skipped and rows pass through untouched", async () => {
  const runners = [busyRunner("runner-1")];
  const { result, requested } = await withJobsApi(
    {},
    () => attachBusyRunnerJobs(runners, [{ repo: "acme/app" }, { runId: 5 }, {}], 4)
  );

  assert.deepEqual(requested, []);
  assert.deepEqual(result, runners);
});
