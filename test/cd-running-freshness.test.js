// The running CD lane must show every live deploy workflow without waiting on
// the enriched per-workflow CD cache.
//
// Reported symptom: an iOS CD run and a Mobile CD run stayed invisible in
// "Deploy and release workflows in progress" for ~20 minutes. Both were live the
// whole time. The enriched CD path caches each workflow's run pages for 10
// minutes, and only a dashboard-performed mutation (rerun failed jobs, the
// Dependabot cleanup) dropped that cache early -- so a run started elsewhere
// waited out the TTL. The actions feed the dashboard already fetches for the CI
// lanes (one request per repo, 60s TTL) knew about them immediately.
//
// The running lane now reads its state from that feed, and because the enriched
// lanes must not disagree with it, a CD run appearing or changing state drops
// the enriched caches (observeCdFeed) so failed and finished rows rebuild in the
// same scan pass -- which is also what keeps the "CD finished" notification from
// firing against a stale lane.
//
// Network is fully mocked; no GitHub is reached.

import test from "node:test";
import assert from "node:assert/strict";
import {
  server,
  resetGithubValueCache,
  fetchCdForRepo,
  observeCdFeed,
  cdFeedFingerprint,
  mergeCdRunningRows
} from "../server.js";

const REPO = "cd-fresh-fixture/app";
const HEAVY_RUNS_PATH = `/repos/${REPO}/actions/workflows/9/runs`;

function rawRun({ id, status, conclusion = null, updatedAt = new Date().toISOString(), runNumber = 12 }) {
  return {
    id,
    name: "Deploy",
    path: ".github/workflows/deploy.yml",
    event: "push",
    status,
    conclusion,
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    updated_at: updatedAt,
    run_number: runNumber,
    head_branch: "main",
    head_sha: "abc123",
    display_title: "deploy main",
    html_url: `https://github.com/${REPO}/actions/runs/${id}`
  };
}

function installGitHubStub(state) {
  const counts = new Map();
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    const pathname = requestUrl.pathname;
    counts.set(pathname, (counts.get(pathname) || 0) + 1);
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": pathname === "/graphql" ? "graphql" : "core"
    };

    if (pathname === "/user") return Response.json({ login: "maintainer" }, { headers });
    if (pathname === "/user/orgs") return Response.json([{ login: "cd-fresh-fixture" }], { headers });
    if (pathname === "/user/repos") return Response.json([], { headers });
    if (pathname === "/orgs/cd-fresh-fixture/repos") {
      return Response.json(
        [{ full_name: REPO, archived: false, owner: { login: "cd-fresh-fixture" } }],
        { headers }
      );
    }
    if (pathname === "/graphql") {
      return Response.json(
        { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
        { headers }
      );
    }
    if (pathname === `/repos/${REPO}/actions/runs`) {
      return Response.json({ workflow_runs: state.feedRuns }, { headers });
    }
    if (pathname === `/repos/${REPO}/actions/workflows`) {
      return Response.json(
        { workflows: [{ id: 9, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active" }] },
        { headers }
      );
    }
    if (pathname === HEAVY_RUNS_PATH) {
      return Response.json({ workflow_runs: state.cdWorkflowRuns }, { headers });
    }
    if (pathname === `/repos/${REPO}/deployments`) return Response.json([], { headers });

    return Response.json({ message: "not found" }, { status: 404, headers });
  };
  return { countFor: (pathname) => counts.get(pathname) || 0 };
}

async function withStubServer(state, run) {
  const realFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const stub = installGitHubStub(state);
  resetGithubValueCache();

  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  const getStatus = async () => {
    const response = await realFetch(
      `http://127.0.0.1:${testServer.address().port}/api/status?mode=all&includeCd=1&includeRunners=0&jobs=1`
    );
    assert.equal(response.status, 200);
    return response.json();
  };

  try {
    await run({ getStatus, stub });
  } finally {
    resetGithubValueCache();
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = realFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
}

// --- the merge itself ---------------------------------------------------------

test("a feed row replaces the stale cached row it matches", () => {
  const cached = { url: "https://x/1", status: "in_progress", title: "old" };
  const fresh = { url: "https://x/1", status: "in_progress", title: "new" };
  assert.deepEqual(mergeCdRunningRows([cached], [fresh]), [fresh]);
});

test("a run the feed reports completed leaves the running lane", () => {
  const cached = { url: "https://x/1", status: "in_progress" };
  const finished = { url: "https://x/1", status: "completed", conclusion: "success" };
  assert.deepEqual(mergeCdRunningRows([cached], [finished]), []);
});

test("a long deploy that aged out of the feed window keeps running", () => {
  // The feed carries the newest 20 runs repo-wide. A 40-minute deploy can fall
  // out of that window while still running, and that is exactly the row an
  // operator is watching -- the cached copy is the only evidence left.
  const cached = { url: "https://x/1", status: "in_progress" };
  assert.deepEqual(mergeCdRunningRows([cached], []), [cached]);
});

// --- the fingerprint (what may and may not invalidate) ------------------------

test("a fingerprint ignores updated_at so progress ticks do not flush the cache", () => {
  const first = cdFeedFingerprint([rawRun({ id: 1, status: "in_progress", updatedAt: "2026-01-01T00:00:00Z" })]);
  const second = cdFeedFingerprint([rawRun({ id: 1, status: "in_progress", updatedAt: "2026-01-01T00:10:00Z" })]);
  assert.equal(first, second);
});

test("a fingerprint changes when a run appears, ends, or changes state", () => {
  const running = cdFeedFingerprint([rawRun({ id: 1, status: "in_progress" })]);
  assert.notEqual(running, cdFeedFingerprint([]), "a run appearing is a transition");
  assert.notEqual(
    running,
    cdFeedFingerprint([rawRun({ id: 1, status: "completed", conclusion: "success" })])
  );
  assert.notEqual(running, cdFeedFingerprint([rawRun({ id: 2, status: "in_progress" })])), "a new run is a transition";
});

// --- the wiring through the real /api/status ----------------------------------

test("a CD run started elsewhere shows in the running lane while the enriched cache is stale", async () => {
  // The enriched cache is warmed to say "this workflow has no runs", and the
  // feed -- the only thing fetched fresh -- carries the live run. The lane must
  // show it without the enriched endpoint being re-read at all.
  const state = { feedRuns: [], cdWorkflowRuns: [] };
  await withStubServer(state, async ({ getStatus, stub }) => {
    await fetchCdForRepo(REPO);
    state.feedRuns = [rawRun({ id: 501, status: "in_progress", runNumber: 12 })];

    const data = await getStatus();
    assert.equal(data.cd.running.length, 1, "the live run reaches the lane");
    assert.equal(data.cd.running[0].runId, 501);
    assert.equal(data.cd.running[0].workflow, "Deploy");
    assert.equal(data.cd.running[0].runNumber, "#12");
    assert.equal(data.summary.runningCd, 1);
    assert.equal(stub.countFor(HEAVY_RUNS_PATH), 1, "the fresh feed needed no refetch of the enriched cache");
  });
});

test("a run the feed reports completed leaves the running lane without a refetch", async () => {
  // The enriched cache still says in_progress here (it is 10 minutes behind by
  // design); the feed is authoritative, so the lane must stop claiming the run
  // is live. This is the difference between "stale" and "wrong".
  const state = {
    feedRuns: [rawRun({ id: 502, status: "in_progress" })],
    cdWorkflowRuns: [rawRun({ id: 502, status: "in_progress" })]
  };
  await withStubServer(state, async ({ getStatus, stub }) => {
    await fetchCdForRepo(REPO);
    state.feedRuns = [rawRun({ id: 502, status: "completed", conclusion: "success" })];

    const data = await getStatus();
    assert.equal(data.cd.running.length, 0, "the completed run is not reported as running");
    assert.equal(data.summary.runningCd, 0);
    assert.equal(stub.countFor(HEAVY_RUNS_PATH), 1, "demotion is the feed's call, not a cache refetch");
  });
});

test("a progress tick on a live run does not refetch the enriched cache", async () => {
  const state = { feedRuns: [], cdWorkflowRuns: [] };
  await withStubServer(state, async ({ getStatus, stub }) => {
    state.feedRuns = [rawRun({ id: 504, status: "in_progress", updatedAt: "2026-01-01T00:00:00Z" })];
    state.cdWorkflowRuns = [rawRun({ id: 504, status: "in_progress", updatedAt: "2026-01-01T00:00:00Z" })];
    await fetchCdForRepo(REPO);
    observeCdFeed(REPO, [rawRun({ id: 504, status: "in_progress", updatedAt: "2026-01-01T00:00:00Z" })]);

    // Only updated_at moved -- the run is still going.
    state.feedRuns = [rawRun({ id: 504, status: "in_progress", updatedAt: "2026-01-01T00:10:00Z" })];

    const data = await getStatus();
    assert.equal(data.cd.running.length, 1);
    assert.equal(stub.countFor(HEAVY_RUNS_PATH), 1, "a tick is not a transition and must not flush the cache");
  });
});

test("a CD transition drops the enriched cache so the finished lane rebuilds in the same pass", async () => {
  // The run is live in both views when the pass starts. By the time the pass
  // reads the feed it has finished, and the enriched lane still holds the old
  // running page. Without the transition-driven invalidation the finished row
  // would not exist -- and the running key would vanish unannounced.
  const state = {
    feedRuns: [rawRun({ id: 503, status: "in_progress" })],
    cdWorkflowRuns: [rawRun({ id: 503, status: "in_progress" })]
  };
  await withStubServer(state, async ({ getStatus, stub }) => {
    await fetchCdForRepo(REPO);
    observeCdFeed(REPO, [rawRun({ id: 503, status: "in_progress" })]);
    state.feedRuns = [rawRun({ id: 503, status: "completed", conclusion: "success" })];
    state.cdWorkflowRuns = [rawRun({ id: 503, status: "completed", conclusion: "success" })];

    const data = await getStatus();
    assert.equal(data.cd.running.length, 0, "the finished run is out of the running lane");
    assert.equal(data.cd.finished.length, 1, "the finished lane rebuilt in the same pass");
    assert.equal(data.cd.finished[0].runId, 503);
    assert.equal(stub.countFor(HEAVY_RUNS_PATH), 2, "the transition forced the enriched page to be re-read");
  });
});
