import test from "node:test";
import assert from "node:assert/strict";

import { DEPLOYMENT_SCAN_LIMIT, fetchRunningDeploymentsForRepo, fetchRecentDeploymentTargets } from "../server.js";

// The deployments pass is the one that put "Partial scan: deployments did not
// finish" on the dashboard, and it was not slow because GitHub was slow: it
// asked githubRestAll to page the whole deployment history 20 rows at a time and
// then read only the first page. On the account that surfaced the banner, 139 of
// 170 list requests were fetched and discarded, one repo spending 34 sequential
// round-trips to produce one page of input. These tests pin the request count,
// not the rows, because the row output never changed -- the cost did.

function deployment(id) {
  return {
    id,
    environment: "production",
    ref: "main",
    task: "deploy",
    created_at: "2026-08-30T12:00:00Z",
    url: `https://api.github.com/repos/acme/app/deployments/${id}`,
    statuses_url: `https://api.github.com/repos/acme/app/deployments/${id}/statuses`
  };
}

// Serves a deployment history far longer than one page and records every path,
// so a regression to full pagination shows up as extra list requests.
async function withDeploymentsApi({ historyLength = 120, state = "in_progress", listFails = false }, run) {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const listRequests = [];
  const statusRequests = [];

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const statusMatch = parsed.pathname.match(/\/deployments\/(\d+)\/statuses$/);
    if (statusMatch) {
      statusRequests.push(parsed.pathname);
      return Response.json([
        {
          state,
          created_at: "2026-08-30T12:30:00Z",
          description: "deploying",
          target_url: "https://app.example.com"
        }
      ]);
    }
    if (parsed.pathname.endsWith("/deployments")) {
      listRequests.push(`${parsed.pathname}?${parsed.searchParams}`);
      if (listFails) return Response.json({ message: "Server Error" }, { status: 500 });
      const perPage = Number(parsed.searchParams.get("per_page"));
      const page = Number(parsed.searchParams.get("page"));
      const start = (page - 1) * perPage;
      const ids = [];
      for (let i = start; i < Math.min(start + perPage, historyLength); i += 1) ids.push(i + 1);
      return Response.json(ids.map(deployment));
    }
    throw new Error(`unexpected request: ${parsed.pathname}`);
  };

  try {
    return { rows: await run(), listRequests, statusRequests };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
}

test("the deployment history is read one page deep, however long it is", async () => {
  const { listRequests } = await withDeploymentsApi({ historyLength: 120 }, () =>
    fetchRunningDeploymentsForRepo("acme/one-page")
  );

  assert.equal(listRequests.length, 1, "a 120-deployment history must still cost one list request");
  assert.match(listRequests[0], /per_page=20/);
  assert.match(listRequests[0], /page=1/);
});

test("status lookups are bounded by the scan limit, not by the history length", async () => {
  const { statusRequests } = await withDeploymentsApi({ historyLength: 500 }, () =>
    fetchRunningDeploymentsForRepo("acme/bounded")
  );

  assert.equal(statusRequests.length, DEPLOYMENT_SCAN_LIMIT);
});

test("running deployments are still reported after the page cap", async () => {
  const { rows } = await withDeploymentsApi({ historyLength: 3, state: "in_progress" }, () =>
    fetchRunningDeploymentsForRepo("acme/still-reports")
  );

  assert.equal(rows.length, 3);
  assert.equal(rows[0].repo, "acme/still-reports");
  assert.equal(rows[0].state, "in_progress");
  assert.equal(rows[0].environment, "production");
});

test("a finished deployment is not reported as running", async () => {
  const { rows } = await withDeploymentsApi({ historyLength: 3, state: "success" }, () =>
    fetchRunningDeploymentsForRepo("acme/finished")
  );

  assert.deepEqual(rows, []);
});

test("a failing list fetch yields no rows instead of sinking the pass", async () => {
  const { rows, statusRequests } = await withDeploymentsApi({ listFails: true }, () =>
    fetchRunningDeploymentsForRepo("acme/list-fails")
  );

  assert.deepEqual(rows, []);
  assert.equal(statusRequests.length, 0);
});

// fetchRecentDeploymentTargets walks the same URLs as the running-deployment
// reader and had the same githubRestAll/slice(0, 20) pair, so the account paid
// the discarded walk twice per repo. It is covered here rather than in its own
// file because the defect, and the fix, are the same one.

test("the deployment-target reader also stops after one page", async () => {
  const { listRequests } = await withDeploymentsApi({ historyLength: 120, state: "success" }, () =>
    fetchRecentDeploymentTargets("acme/targets-one-page")
  );

  assert.equal(listRequests.length, 1);
  assert.match(listRequests[0], /per_page=20/);
});

test("deployment targets are still resolved from the first page", async () => {
  const { rows } = await withDeploymentsApi({ historyLength: 3, state: "success" }, () =>
    fetchRecentDeploymentTargets("acme/targets-resolve")
  );

  assert.equal(rows.size, 1, "three deployments share one ref, so one target is kept");
  assert.equal(rows.get("main").environment, "production");
});
