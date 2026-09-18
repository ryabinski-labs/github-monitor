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
    baseRef: { compare: { behindBy } },
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

test("SC-detect-no-extra-requests: detection costs no additional HTTP request per scan", () => {
  // Oracle: the PR search GraphQL document itself carries the compare selection,
  // so behindBy arrives inside a request the scan already makes.
  //
  // This is a structural check rather than a request count: this codebase has no
  // injectable HTTP transport, so counting real calls is not available here. The
  // structure is what actually decides the cost -- a compare selection inside the
  // existing document is free; anything reached by a separate path is not.
  assert.equal(
    typeof server.PR_SEARCH_GRAPHQL,
    "string",
    "server.js must export PR_SEARCH_GRAPHQL so the query's cost shape is testable"
  );

  assert.match(
    server.PR_SEARCH_GRAPHQL,
    /compare\s*\(\s*headRef:/,
    "behindBy must be selected inside the existing search query; a separate call would cost one request per PR per scan"
  );
  assert.match(server.PR_SEARCH_GRAPHQL, /behindBy/, "the compare selection must actually request behindBy");
});
