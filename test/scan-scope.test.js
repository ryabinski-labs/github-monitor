import test from "node:test";
import assert from "node:assert/strict";

// Read at import time, so they have to be set before server.js loads.
process.env.SCAN_PUSHED_WITHIN_HOURS = "24";
// The default floor of 10 would keep every repo in a fixture this small, which
// would make the fan-out assertions pass for the wrong reason.
process.env.SCAN_REPO_FLOOR = "0";
// A developer's .env is loaded by server.js at import and would otherwise route
// these stubbed requests through App auth instead of the token path below.
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";

const { selectActiveRepos, scanScopeSnapshot, server } = await import("../server.js");

const NOW = Date.parse("2026-08-30T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function repo(fullName, agoMs) {
  return { fullName, pushedAt: agoMs === null ? null : new Date(NOW - agoMs).toISOString() };
}

const OPTS = { withinMs: 7 * DAY, floor: 0, now: NOW };

test("a repo pushed inside the window is scanned and a dormant one is not", () => {
  const selected = selectActiveRepos([repo("acme/live", 2 * HOUR), repo("acme/dormant", 30 * DAY)], OPTS);
  assert.deepEqual(selected, ["acme/live"]);
});

test("an open pull request keeps a dormant repo in scope", () => {
  // The whole risk of this filter: pushed_at does not move for a scheduled run,
  // a workflow_dispatch, or a review on a months-old branch. An open PR is
  // direct evidence the repo is live, and the search that produced it has
  // already been paid for.
  const candidates = [repo("acme/live", HOUR), repo("acme/stale-pr", 90 * DAY)];
  assert.deepEqual(selectActiveRepos(candidates, { ...OPTS, keep: ["acme/stale-pr"] }), [
    "acme/live",
    "acme/stale-pr"
  ]);
});

test("the floor keeps the most recently pushed repos when the whole account is quiet", () => {
  // Without this, a quiet fortnight empties the deck while looking like a
  // successful scan -- worse than the fan-out it saves.
  const candidates = [
    repo("acme/newest", 8 * DAY),
    repo("acme/older", 20 * DAY),
    repo("acme/oldest", 400 * DAY)
  ];
  assert.deepEqual(selectActiveRepos(candidates, { ...OPTS, floor: 2 }), ["acme/newest", "acme/older"]);
});

test("the floor is not spent on repos that have no push date", () => {
  // Undated repos are kept regardless, so letting them take floor slots would
  // hand the budget to exactly the repos it exists to protect against.
  const candidates = [repo("acme/undated", null), repo("acme/newest", 8 * DAY), repo("acme/older", 20 * DAY)];
  assert.deepEqual(selectActiveRepos(candidates, { ...OPTS, floor: 1 }), ["acme/newest", "acme/undated"]);
});

test("a repo with no push date at all is kept rather than guessed at", () => {
  assert.deepEqual(selectActiveRepos([repo("acme/undated", null)], OPTS), ["acme/undated"]);
});

test("a pushed_at in the future is treated as recent, not as unparseable", () => {
  assert.deepEqual(selectActiveRepos([repo("acme/skewed", -3 * DAY)], OPTS), ["acme/skewed"]);
});

test("an unparseable pushed_at falls back to keeping the repo", () => {
  const selected = selectActiveRepos([{ fullName: "acme/broken", pushedAt: "not a date" }], OPTS);
  assert.deepEqual(selected, ["acme/broken"]);
});

test("SCAN_PUSHED_WITHIN_HOURS=0 disables the filter entirely", () => {
  const candidates = [repo("acme/live", HOUR), repo("acme/ancient", 900 * DAY)];
  assert.deepEqual(selectActiveRepos(candidates, { ...OPTS, withinMs: 0 }), ["acme/ancient", "acme/live"]);
});

test("duplicate repos across owners collapse to one, as they did before the filter", () => {
  const candidates = [repo("acme/app", HOUR), repo("acme/app", 2 * HOUR), repo("acme/other", HOUR)];
  assert.deepEqual(selectActiveRepos(candidates, OPTS), ["acme/app", "acme/other"]);
});

test("plain repo names still work and are never filtered out", () => {
  assert.deepEqual(selectActiveRepos(["acme/app", "acme/app", "acme/two"], OPTS), ["acme/app", "acme/two"]);
});

test("scanScopeSnapshot reports the gap between considered and scanned", () => {
  const snapshot = scanScopeSnapshot({ reposConsidered: 89, reposScanned: 15 });
  assert.equal(snapshot.reposSkipped, 74);
  assert.equal(snapshot.pushedWithinHours, 24);
  assert.equal(snapshot.repoFloor, 0);
});

test("scanScopeSnapshot never reports a negative skip count", () => {
  assert.equal(scanScopeSnapshot(null).reposSkipped, 0);
  assert.equal(scanScopeSnapshot({ reposConsidered: 2, reposScanned: 5 }).reposSkipped, 0);
});

test("a dormant repo costs the scan no requests end to end", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const requested = [];

  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    requested.push(requestUrl.pathname);
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": requestUrl.pathname === "/graphql" ? "graphql" : "core"
    };
    if (requestUrl.pathname === "/user") return Response.json({ login: "maintainer" }, { headers });
    if (requestUrl.pathname === "/user/orgs") return Response.json([{ login: "acme" }], { headers });
    if (requestUrl.pathname === "/user/repos") return Response.json([], { headers });
    if (requestUrl.pathname === "/orgs/acme/repos") {
      return Response.json([
        { full_name: "acme/live", archived: false, pushed_at: new Date().toISOString() },
        { full_name: "acme/dormant", archived: false, pushed_at: "2025-01-01T00:00:00Z" },
        { full_name: "acme/abandoned", archived: false, pushed_at: "2024-06-01T00:00:00Z" }
      ], { headers });
    }
    if (requestUrl.pathname === "/graphql") {
      return Response.json(
        { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
        { headers }
      );
    }
    if (requestUrl.pathname === "/repos/acme/live/actions/runs") {
      return Response.json({ workflow_runs: [] }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await previousFetch(
      `http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`
    );
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.scan.reposConsidered, 3);
    assert.equal(data.scan.reposScanned, 1);
    assert.equal(data.scan.reposSkipped, 2);
    assert.equal(data.summary.repos, 1);

    const dormantRequests = requested.filter((path) => path.includes("/dormant") || path.includes("/abandoned"));
    assert.deepEqual(dormantRequests, [], `dormant repos were still fetched: ${dormantRequests.join(", ")}`);
    assert.ok(requested.includes("/repos/acme/live/actions/runs"), "the live repo is still scanned");
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});
