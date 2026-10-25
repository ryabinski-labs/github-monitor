// End-to-end wiring for the Dependabot pass: an accessible repo with open
// critical/high alerts reaches the payload, a denied repo is named as unchecked
// instead of silently disappearing, and the PR/CD scan's own scope is untouched.
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";
process.env.GITHUB_TOKEN = "test-token";
process.env.SCAN_REPO_FLOOR = "0";
process.env.SCAN_PUSHED_WITHIN_HOURS = "168";

import test from "node:test";
import assert from "node:assert/strict";

const { server, resetGithubValueCache, resetLastKnownOwnerRepos } = await import("../server.js");

const realFetch = globalThis.fetch;

const headersFor = () => ({
  "content-type": "application/json",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4990",
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "x-ratelimit-resource": "core"
});

function alert({ number, severity, createdAt, state = "open" }) {
  return {
    number,
    state,
    created_at: createdAt,
    security_vulnerability: { severity }
  };
}

function stubGithub() {
  const requested = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    const { pathname } = requestUrl;
    requested.push({ pathname, search: requestUrl.search });
    const headers = headersFor();
    if (pathname === "/user") return Response.json({ login: "maintainer" }, { headers });
    if (pathname === "/user/orgs") return Response.json([{ login: "acme" }], { headers });
    if (pathname === "/user/repos") return Response.json([], { headers });
    if (pathname === "/orgs/acme/repos") {
      return Response.json([
        // Old enough that the active PR/CD scan skips it.
        { full_name: "acme/quiet", archived: false, pushed_at: "2025-01-01T00:00:00Z" },
        { full_name: "acme/denied", archived: false, pushed_at: new Date().toISOString() },
        { full_name: "acme/weird", archived: false, pushed_at: new Date().toISOString() },
        { full_name: "acme/paged", archived: false, pushed_at: new Date().toISOString() }
      ], { headers });
    }
    if (pathname === "/graphql") {
      return Response.json({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }, { headers });
    }
    if (pathname === "/repos/acme/quiet/dependabot/alerts") {
      return Response.json([
        alert({ number: 1, severity: "critical", createdAt: "2026-08-01T00:00:00Z" }),
        alert({ number: 2, severity: "high", createdAt: "2026-09-01T00:00:00Z" }),
        alert({ number: 3, severity: "medium", createdAt: "2026-07-01T00:00:00Z" }),
        alert({ number: 4, severity: "critical", createdAt: "2026-06-01T00:00:00Z", state: "dismissed" })
      ], { headers });
    }
    if (pathname === "/repos/acme/denied/dependabot/alerts") {
      return Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403, headers }
      );
    }
    if (pathname === "/repos/acme/weird/dependabot/alerts") {
      // A 200 whose body is not an alert array must not read as "no alerts".
      return Response.json({ message: "unexpected shape" }, { headers });
    }
    if (pathname === "/repos/acme/paged/dependabot/alerts") {
      // Dependabot alerts use a Link cursor, not `?page=`. A full first page
      // must be followed or the second page's critical alert is lost.
      if (!requestUrl.searchParams.get("after")) {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => alert({
            number: index + 1,
            severity: "medium",
            createdAt: "2026-05-01T00:00:00Z"
          })),
          {
            headers: {
              ...headers,
              link: '<https://api.github.com/repos/acme/paged/dependabot/alerts?after=cursor2>; rel="next"'
            }
          }
        );
      }
      return Response.json([
        alert({ number: 200, severity: "critical", createdAt: "2026-01-01T00:00:00Z" })
      ], { headers });
    }
    if (["/repos/acme/quiet/actions/runs", "/repos/acme/denied/actions/runs", "/repos/acme/weird/actions/runs", "/repos/acme/paged/actions/runs"].includes(pathname)) {
      return Response.json({ workflow_runs: [] }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };
  return requested;
}

test("the dashboard payload carries the critical/high projects and names every unchecked project", async () => {
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  resetGithubValueCache();
  resetLastKnownOwnerRepos();
  const requested = stubGithub();
  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await realFetch(
      `http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`
    );
    assert.equal(response.status, 200);
    const data = await response.json();

    assert.equal(data.dependabot.repos.length, 2);
    const quiet = data.dependabot.repos.find((entry) => entry.repo === "acme/quiet");
    assert.equal(quiet.critical, 1);
    assert.equal(quiet.high, 1);
    assert.equal(quiet.oldestAt, "2026-08-01T00:00:00Z");
    assert.equal(quiet.url, "https://github.com/acme/quiet/security/dependabot");
    const paged = data.dependabot.repos.find((entry) => entry.repo === "acme/paged");
    assert.equal(paged.critical, 1, "the second cursor page's alert must be counted");

    assert.equal(data.dependabot.unchecked.length, 2);
    const denied = data.dependabot.unchecked.find((entry) => entry.repo === "acme/denied");
    assert.match(denied.reason, /Dependabot alerts: Read/);
    const weird = data.dependabot.unchecked.find((entry) => entry.repo === "acme/weird");
    assert.match(weird.reason, /Unexpected Dependabot alerts response shape/);

    assert.equal(data.summary.vulnerableRepos, 2);
    assert.equal(data.summary.criticalAlerts, 2);
    assert.equal(data.summary.highAlerts, 1);
    assert.equal(data.summary.uncheckedVulnerableRepos, 2);

    // A quiet repo is not in the PR/CD scan, but the security pass still reads
    // its alerts. The denied repo is a normal unchecked result, not a degraded
    // section that changes the meaning of every other lane.
    assert.ok(requested.some((entry) => entry.pathname === "/repos/acme/quiet/dependabot/alerts"));
    assert.ok(!requested.some((entry) => entry.pathname === "/repos/acme/quiet/actions/runs"));
    assert.ok(
      requested.every((entry) => !entry.pathname.endsWith("/dependabot/alerts") || !new URLSearchParams(entry.search).has("page")),
      "Dependabot alerts must never be called with the rejected page parameter"
    );
    assert.ok(
      requested.some((entry) => entry.pathname === "/repos/acme/paged/dependabot/alerts" && entry.search.includes("after=cursor2")),
      "the Link cursor must be followed to the second page"
    );
    assert.ok(!data.degraded.includes("dependabot"));
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = realFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    resetGithubValueCache();
    resetLastKnownOwnerRepos();
  }
});
