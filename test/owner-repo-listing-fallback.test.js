import test from "node:test";
import assert from "node:assert/strict";

// A developer's .env is loaded by server.js at import and would otherwise route
// these stubbed requests through App auth instead of the token path below.
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";

const { server, resetGithubValueCache, resetLastKnownOwnerRepos } = await import("../server.js");

// Captured before any stub is installed: the test talks to its own server with this.
const realFetch = globalThis.fetch;

const headersFor = (pathname) => ({
  "content-type": "application/json",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4990",
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "x-ratelimit-resource": pathname === "/graphql" ? "graphql" : "core"
});

// The org has one repo with a deploy running on main and no open PR -- the exact
// row that vanished when the listing failed, because only the PR search keeps a
// repo in scope without it.
function stubGithub({ listingFails }) {
  const requested = [];
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    requested.push(pathname);
    const headers = headersFor(pathname);
    if (pathname === "/user") return Response.json({ login: "maintainer" }, { headers });
    if (pathname === "/user/orgs") return Response.json([{ login: "acme" }], { headers });
    if (pathname === "/user/repos") return Response.json([], { headers });
    if (pathname === "/orgs/acme/repos") {
      if (listingFails()) return Response.json({ message: "Server Error" }, { status: 502, headers });
      return Response.json([{ full_name: "acme/app", archived: false, pushed_at: new Date().toISOString() }], { headers });
    }
    if (pathname === "/graphql") {
      return Response.json({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }, { headers });
    }
    if (pathname === "/repos/acme/app/actions/runs") {
      return Response.json({
        workflow_runs: [{
          id: 7,
          name: "CI",
          run_number: 42,
          status: "in_progress",
          event: "push",
          head_branch: "main",
          head_sha: "abc",
          created_at: new Date().toISOString(),
          pull_requests: [],
          html_url: "https://github.com/acme/app/actions/runs/7"
        }]
      }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };
  return requested;
}

async function withServer(fn) {
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  resetGithubValueCache();
  resetLastKnownOwnerRepos();
  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const { port } = testServer.address();
  const status = async () => {
    // Every scan re-lists the owner, as it does once the 5-minute cache expires.
    resetGithubValueCache();
    const response = await realFetch(
      `http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`
    );
    return response.json();
  };
  try {
    await fn(status);
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = realFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    resetGithubValueCache();
    resetLastKnownOwnerRepos();
  }
}

test("a failed owner listing falls back to the last known list instead of emptying the org", async () => {
  let fail = false;
  stubGithub({ listingFails: () => fail });
  await withServer(async (status) => {
    const healthy = await status();
    assert.equal(healthy.scan.reposConsidered, 1);
    assert.equal(healthy.actions.running.length, 1);
    assert.deepEqual(healthy.degraded, []);

    fail = true;
    const data = await status();
    assert.equal(data.scan.reposConsidered, 1, "the org's repos must not silently drop out of the scan");
    assert.equal(data.actions.running.length, 1, "the running run is still shown");
    assert.ok(data.degraded.includes("repos"), "the scan says its repo list is stale");
    assert.ok(
      data.warnings.some((warning) => warning.includes("acme repository list") && warning.includes("last known")),
      `expected a stale-listing warning, got: ${JSON.stringify(data.warnings)}`
    );
  });
});

test("a failed owner listing with nothing to fall back on is reported, not passed off as a quiet org", async () => {
  stubGithub({ listingFails: () => true });
  await withServer(async (status) => {
    const data = await status();
    assert.equal(data.scan.reposConsidered, 0);
    assert.ok(data.degraded.includes("repos"));
    assert.ok(
      data.warnings.some((warning) => warning.startsWith("Could not list acme repositories")),
      `expected a listing-failure warning, got: ${JSON.stringify(data.warnings)}`
    );
    assert.ok(
      !data.warnings.some((warning) => warning.startsWith("Partial scan: repos")),
      "the generic partial-scan warning does not duplicate the specific one"
    );
  });
});
