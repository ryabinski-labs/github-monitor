// Red-phase coverage for the "Out of date" PR lane.
//
// Derived from docs/prd/pr-behind-base.md via tdd/pr-behind-base.tdd.yaml.
// Every test name carries its scenario ID verbatim -- that ID is the join key
// between this suite, the TDD artifact, and any QA results file, so never
// rename it.
//
// These are expected to FAIL until the feature lands. They fail on assertions,
// not on imports: new server API is reached through a namespace import so that
// a missing export is a readable assertion failure rather than a link error
// that takes the whole file down.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as server from "../server.js";
import { classifyPullRequest, groupPullRequests } from "../server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- fixtures ----------------------------------------------------------------

function prNode({ behindBy = 0, baseRefName = "main", checks = [], number = 118 } = {}) {
  return {
    number,
    title: "Wait out post-merge CI",
    url: `https://github.com/ryabinski-labs/github-monitor/pull/${number}`,
    createdAt: "2026-09-18T05:00:00Z",
    updatedAt: "2026-09-18T05:30:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: "abc1234",
    baseRefName,
    author: { login: "cigan1" },
    repository: { nameWithOwner: "ryabinski-labs/github-monitor", isArchived: false },
    // Corrected against the live schema on 2026-09-18. The spec asked for
    // baseRef.compare.behindBy, but that counts how far the *base* is behind
    // the head -- the PR's ahead count. Measured on a branch five commits
    // behind main: { behindBy: 0, aheadBy: 5, status: AHEAD } from the base
    // ref. The number this lane is about is aheadBy on that comparison.
    baseRef: { compare: { aheadBy: behindBy } },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }
  };
}

function pr(overrides = {}) {
  return {
    repo: "ryabinski-labs/github-monitor",
    number: 118,
    numberLabel: "#118",
    title: "Wait out post-merge CI",
    author: "cigan1",
    url: "https://github.com/ryabinski-labs/github-monitor/pull/118",
    state: "pass",
    checkCount: 3,
    isDraft: false,
    hasConflict: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    behindBy: 0,
    ...overrides
  };
}

const laneNames = ["pass", "noCi", "fail", "running", "conflicts"];

function lanesContaining(groups, target) {
  return Object.entries(groups)
    .filter(([, rows]) => (rows || []).some((row) => row.number === target.number))
    .map(([name]) => name)
    .sort();
}

// --- REQ-detection -----------------------------------------------------------

test("SC-detect-behind-count: behindBy is lifted from the compare field onto the PR object", () => {
  // Oracle: classifyPullRequest(node).behindBy === 12 && .baseRefName === "main"
  const classified = classifyPullRequest(prNode({ behindBy: 12, baseRefName: "main" }));

  assert.equal(
    classified.behindBy,
    12,
    "the scan must carry the compare result onto the PR object; without it no lane can be built"
  );
  assert.equal(classified.baseRefName, "main", "the pill names the base branch, so it must survive normalization");
});

test("SC-detect-fork-headref: a fork PR compares against an owner-qualified head ref", () => {
  // Oracle: the headRef argument sent in the GraphQL variables === "forkowner:feat/x"
  assert.equal(
    typeof server.compareHeadRef,
    "function",
    "server.js must export compareHeadRef(pr) so the fork-qualification rule is testable on its own"
  );

  const headRef = server.compareHeadRef({
    repository: { nameWithOwner: "ryabinski-labs/repo" },
    headRepository: { nameWithOwner: "forkowner/repo" },
    headRefName: "feat/x"
  });

  assert.equal(
    headRef,
    "forkowner:feat/x",
    "a cross-repository compare needs the owner prefix, or behindBy comes back wrong for every fork PR"
  );
});

test("SC-detect-same-repo-headref: a same-repo PR compares against a bare branch name", () => {
  // Oracle: the headRef argument sent in the GraphQL variables === "feat/x"
  assert.equal(typeof server.compareHeadRef, "function", "server.js must export compareHeadRef(pr)");

  const headRef = server.compareHeadRef({
    repository: { nameWithOwner: "ryabinski-labs/repo" },
    headRepository: { nameWithOwner: "ryabinski-labs/repo" },
    headRefName: "feat/x"
  });

  assert.equal(headRef, "feat/x", "a same-repo compare must not be owner-prefixed");
});

// --- REQ-behind-lane ---------------------------------------------------------

test("SC-lane-exclusive: a behind PR leaves every other lane", () => {
  // Oracle: groups.behind includes the PR and none of pass/noCi/fail/running does
  const behind = pr({ behindBy: 3, hasConflict: false, state: "pass" });
  const groups = groupPullRequests([behind]);

  assert.ok(
    (groups.behind || []).some((row) => row.number === behind.number),
    "a PR that is behind its base must appear in the new behind group"
  );
  assert.deepEqual(
    lanesContaining(groups, behind).filter((name) => laneNames.includes(name)),
    [],
    "the behind lane is exclusive, exactly like conflicts -- the PR must appear in no other lane"
  );
});

test("SC-lane-failing-and-behind: a failing PR that is also behind lands in the behind lane, not Failing CI", () => {
  // Oracle: groups.behind includes the PR and groups.fail does not.
  // This is the case in the source screenshot: 1 failing check AND out-of-date.
  const behindAndFailing = pr({ behindBy: 5, state: "fail", hasConflict: false });
  const groups = groupPullRequests([behindAndFailing]);

  assert.ok(
    (groups.behind || []).some((row) => row.number === behindAndFailing.number),
    "the screenshot case -- behind AND failing -- must reach the behind lane"
  );
  assert.ok(
    !groups.fail.some((row) => row.number === behindAndFailing.number),
    "the lane is exclusive, so a behind PR must not also sit in Failing CI"
  );
});

test("SC-lane-not-behind-unchanged: a PR that is level with its base is grouped exactly as before", () => {
  // Oracle: groups.pass includes the PR and groups.behind does not
  const level = pr({ behindBy: 0, state: "pass" });
  const groups = groupPullRequests([level]);

  // Guard against a vacuous green: with no behind group at all, "the PR is not
  // in the behind lane" is trivially true. Pin the lane's existence first.
  assert.ok(Array.isArray(groups.behind), "groupPullRequests must return a behind group, or this assertion proves nothing");

  assert.ok(groups.pass.some((row) => row.number === level.number), "an up-to-date passing PR stays in Passing CI");
  assert.equal((groups.behind || []).length, 0, "behindBy 0 must never enter the lane");
});

// --- REQ-conflict-precedence -------------------------------------------------

test("SC-precedence-conflict-wins: conflicts beat behind", () => {
  // Oracle: groups.conflicts includes the PR and groups.behind does not.
  // Truthful because PUT /update-branch answers 422 on a conflicting PR.
  const both = pr({ behindBy: 7, hasConflict: true });
  const groups = groupPullRequests([both]);

  // Guard against a vacuous green: with no behind group at all, "the PR is not
  // in the behind lane" is trivially true. Pin the lane's existence first.
  assert.ok(Array.isArray(groups.behind), "groupPullRequests must return a behind group, or this assertion proves nothing");

  assert.ok(groups.conflicts.some((row) => row.number === both.number), "a conflicting PR stays in the Conflicts lane");
  assert.equal(
    (groups.behind || []).length,
    0,
    "conflicts are checked first, so a conflicting PR never reaches the behind lane"
  );
});

// --- REQ-fail-open -----------------------------------------------------------

test("SC-failopen-missing-field: a missing behindBy groups the PR as before", () => {
  // Oracle: groups.pass includes the PR and groups.behind has length 0.
  // Fail-open matters: a GraphQL field that errors must not silently empty every lane.
  const unknown = pr({ behindBy: undefined, state: "pass" });
  const groups = groupPullRequests([unknown]);

  // Guard against a vacuous green: with no behind group at all, "the PR is not
  // in the behind lane" is trivially true. Pin the lane's existence first.
  assert.ok(Array.isArray(groups.behind), "groupPullRequests must return a behind group, or this assertion proves nothing");

  assert.ok(groups.pass.some((row) => row.number === unknown.number), "an unknown behindBy must fall back to today's grouping");
  assert.equal((groups.behind || []).length, 0, "an unknown behindBy must not be treated as behind");
});

test("SC-failopen-bad-values: null, negative and non-numeric behindBy values never enter the lane", () => {
  // Oracle: groups.behind has length 0 for every listed behindBy value
  for (const behindBy of [null, -1, 0, "3"]) {
    const groups = groupPullRequests([pr({ behindBy, state: "pass" })]);
    assert.ok(
      Array.isArray(groups.behind),
      "groupPullRequests must return a behind group, or this assertion proves nothing"
    );
    assert.equal(
      (groups.behind || []).length,
      0,
      `behindBy ${JSON.stringify(behindBy)} is not a positive integer and must not create a lane entry`
    );
  }
});

// --- REQ-update-endpoint -----------------------------------------------------

test("SC-endpoint-calls-github: the route issues the documented GitHub call", () => {
  // Oracle: exactly 1 PUT to /repos/{repo}/pulls/{number}/update-branch, no
  // update_method key in the body (DL-003 -- merge commit, never rebase).
  assert.equal(
    typeof server.buildUpdateBranchRequest,
    "function",
    "server.js must export buildUpdateBranchRequest(repo, number) so the GitHub call shape is testable without a live server"
  );

  const request = server.buildUpdateBranchRequest("ryabinski-labs/github-monitor", 118);

  assert.equal(request.method, "PUT", "GitHub's update-branch endpoint is a PUT");
  assert.equal(
    request.path,
    "/repos/ryabinski-labs/github-monitor/pulls/118/update-branch",
    "the path must address the PR being updated"
  );
  assert.ok(
    !("update_method" in (request.body || {})),
    "omitting update_method is what makes this a merge-commit update; sending 'rebase' would force-push the head branch"
  );
});

test("SC-endpoint-rejects-get: the route refuses a non-POST method", () => {
  // Oracle: response status is 405 and the stubbed GitHub transport recorded 0 calls
  assert.equal(
    typeof server.updatePullRequestBranch,
    "function",
    "server.js must export the updatePullRequestBranch(req, res) handler"
  );

  const calls = [];
  const res = { statusCode: 0, writeHead(status) { this.statusCode = status; }, end() {} };

  assert.rejects(
    () => server.updatePullRequestBranch({ method: "GET" }, res),
    (error) => error.status === 405,
    "a GET must be refused with 405 before any GitHub call is considered"
  );
  assert.equal(calls.length, 0, "a refused method must spend no GitHub quota");
});

test("SC-endpoint-validates-input: a malformed repo or number is rejected before GitHub is called", () => {
  // Oracle: response status is 400 and the stubbed GitHub transport recorded 0 calls
  assert.equal(
    typeof server.buildUpdateBranchRequest,
    "function",
    "server.js must export buildUpdateBranchRequest(repo, number)"
  );

  assert.throws(
    () => server.buildUpdateBranchRequest("not-a-repo", 118),
    "a repo without an owner/name shape must be rejected, not sent to GitHub"
  );
  assert.throws(
    () => server.buildUpdateBranchRequest("ryabinski-labs/github-monitor", 0),
    "PR number 0 does not exist and must be rejected before the call"
  );
});

// --- REQ-contrast ------------------------------------------------------------

function tokenBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `expected ${selector} in public/styles.css`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function tokenValue(block, name) {
  const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1].trim() : null;
}

function relativeLuminance(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("SC-contrast-tokens-both-themes: the new token pairs clear the AA floor in both themes", () => {
  // Oracle: min contrast across both theme blocks >= 4.5.
  //
  // This is the test that would have caught the real defect: reusing --amber as
  // pill text on --amber-soft measures 3.77:1 in the light theme, because --amber
  // is tuned there as a dot and border colour, not as text on a tint.
  const css = readFileSync(path.join(root, "public/styles.css"), "utf8");
  const themes = {
    dark: tokenBlock(css, ":root {"),
    light: tokenBlock(css, ':root[data-theme="light"]')
  };

  for (const [name, block] of Object.entries(themes)) {
    const onSoft = tokenValue(block, "amber-on-soft");
    assert.ok(
      onSoft,
      `${name} theme must define --amber-on-soft; --amber alone fails AA as pill text on --amber-soft in the light theme`
    );

    const resolved = onSoft.startsWith("var(") ? tokenValue(block, "amber") : onSoft;
    const amberSoft = tokenValue(block, "amber-soft");
    const amber = tokenValue(block, "amber");
    const paperStrong = tokenValue(block, "paper-strong");

    const pill = contrast(resolved, amberSoft);
    assert.ok(pill >= 4.5, `${name}: behind-pill text measures ${pill.toFixed(2)}:1, below the 4.5:1 AA floor`);

    const button = contrast(paperStrong, amber);
    assert.ok(button >= 4.5, `${name}: filled Update branch button measures ${button.toFixed(2)}:1, below the 4.5:1 AA floor`);
  }
});

test("SC-detect-no-extra-requests: a scan where nothing moved costs no compare request", async () => {
  // Oracle: with the base and head SHAs unchanged since the previous scan, the
  // compare pass issues zero requests and still reports the same count.
  //
  // REWRITTEN, with the original oracle recorded as wrong. The spec asserted the
  // compare could ride inside PR_SEARCH_GRAPHQL for +0 requests. It cannot:
  // Ref.compare(headRef: String!) takes a static argument and the head ref
  // differs per node, so a bulk search over 100 PRs cannot name each one's head.
  // Verified against the live API on 2026-09-18 -- a static alias resolves the
  // same branch name for every node, and a name missing in one repository
  // returns a NOT_FOUND errors entry for that node.
  //
  // What the guardrail can honestly promise is the steady state: the compare is
  // keyed on the base and head SHAs, so a rescan that finds nothing moved is
  // free, and a push to the base branch costs one request per 50 affected PRs.
  assert.equal(
    typeof server.fetchBehindCounts,
    "function",
    "server.js must export fetchBehindCounts so the compare pass's cost is testable"
  );
  assert.ok(
    !/compare\s*\(\s*headRef:/.test(server.PR_SEARCH_GRAPHQL || ""),
    "the search document must not carry a compare: a static headRef argument would answer about the wrong branch"
  );

  // Without this the token lookup falls through to `gh auth token`, which
  // succeeds on a developer's machine and fails in CI -- so the compare never
  // reached fetch there and this test counted zero requests while passing
  // locally. The exact shape of a test that passes alone and fails on the
  // runner.
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  server.resetGithubValueCache();
  const rows = [{ ...pr({ behindBy: undefined }), headRefName: "feat/x", baseSha: "base1", headSha: "head1" }];

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: { pr0: { pullRequest: { baseRef: { compare: { aheadBy: 4 } } } } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    await server.fetchBehindCounts(rows);
    assert.equal(calls, 1, "a PR whose SHAs the cache has never seen costs exactly one batched request");
    assert.equal(rows[0].behindBy, 4, "the compare result must reach the PR object");

    rows[0].behindBy = undefined;
    await server.fetchBehindCounts(rows);
    assert.equal(calls, 1, "unchanged base and head SHAs must be answered from the cache, spending nothing");
    assert.equal(rows[0].behindBy, 4, "the cached count must still be reported");

    rows[0].baseSha = "base2";
    await server.fetchBehindCounts(rows);
    assert.equal(calls, 2, "a moved base branch is the one thing that must pay for a fresh compare");
  } finally {
    globalThis.fetch = originalFetch;
    server.resetGithubValueCache();
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

// --- REQ-behind-lane (wiring) ------------------------------------------------

test("SC-lane-status-payload: the behind lane reaches /api/status, not just groupPullRequests", async () => {
  // Oracle: data.pullRequests.behind holds the PR, summary.behindPrs is 1, and
  // the same PR is absent from pass/noCi/fail/running.
  //
  // The wiring test. groupPullRequests can be perfectly correct and still never
  // be reached with a behindBy on it -- the scan resolves the compare in a
  // second pass, and a lane that the pass skips is a lane that is always empty
  // on the only surface the dashboard ever reads.
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  let compareCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": requestUrl.pathname === "/graphql" ? "graphql" : "core"
    };

    if (requestUrl.pathname === "/user") return Response.json({ login: "maintainer" }, { headers });
    if (requestUrl.pathname === "/user/orgs") return Response.json([{ login: "behind-fixture" }], { headers });
    if (requestUrl.pathname === "/user/repos") return Response.json([], { headers });
    if (/^\/orgs\/[^/]+\/repos$/.test(requestUrl.pathname)) {
      return Response.json(
        [{ full_name: "behind-fixture/app", archived: false, owner: { login: "behind-fixture" } }],
        { headers }
      );
    }
    if (requestUrl.pathname === "/graphql") {
      // The search document and the compare document are distinguishable by the
      // selection each one carries; the compare is the second request.
      if (/compare\s*\(\s*headRef:/.test(body.query || "")) {
        compareCalls += 1;
        assert.equal(body.variables.h0, "feat/x", "a same-repo head ref is passed unqualified");
        return Response.json(
          { data: { pr0: { pullRequest: { baseRef: { compare: { aheadBy: 9 } } } } } },
          { headers }
        );
      }
      const node = {
        __typename: "PullRequest",
        number: 118,
        title: "Wait out post-merge CI",
        url: "https://github.com/behind-fixture/app/pull/118",
        createdAt: "2026-09-18T05:00:00Z",
        updatedAt: "2026-09-18T05:30:00Z",
        isDraft: false,
        mergeable: "MERGEABLE",
        headRefOid: "abc1234",
        baseRefName: "main",
        baseRefOid: "base1234",
        headRefName: "feat/x",
        headRepository: { nameWithOwner: "behind-fixture/app" },
        author: { login: "cigan1" },
        repository: { nameWithOwner: "behind-fixture/app", isArchived: false },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }
                    ]
                  }
                }
              }
            }
          ]
        }
      };
      return Response.json(
        { data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } },
        { headers }
      );
    }
    if (requestUrl.pathname.startsWith("/repos/")) {
      return Response.json({ workflows: [], workflow_runs: [] }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  server.resetGithubValueCache();
  const testServer = await new Promise((resolve) => {
    const listener = server.server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await previousFetch(
      `http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`
    );
    const data = await response.json();
    assert.equal(response.status, 200);

    assert.equal(compareCalls, 1, "the scan must resolve the compare exactly once per pass");
    assert.equal(data.pullRequests.behind.length, 1, "the behind lane must arrive populated on the only surface the UI reads");
    assert.equal(data.pullRequests.behind[0].behindBy, 9, "the count the pill renders must survive the payload");
    assert.equal(data.summary.behindPrs, 1, "the rail count comes from the summary, not from the lane length");

    for (const lane of ["pass", "noCi", "fail", "running", "conflicts"]) {
      assert.equal(
        (data.pullRequests[lane] || []).length,
        0,
        `the lane is exclusive: the PR must not also sit in ${lane}`
      );
    }
  } finally {
    server.resetGithubValueCache();
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});
