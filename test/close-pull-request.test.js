// Closing a PR used to be a silent one-click action: the API took only
// {repo, number}, closed the PR, and posted nothing. The actor in the timeline
// is the App/PAT, so nobody could tell why it happened or who asked for it.
// These tests pin the two guards: a reason is mandatory, and the reason plus
// the configured operator is posted as a comment BEFORE the close.

import test from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";
process.env.GITHUB_TOKEN = "test-token";
process.env.DASHBOARD_OPERATOR = "cigan1";

const {
  server,
  dashboardOperator,
  normalizeCloseReason,
  closeAuditComment,
  closePullRequestWithReason
} = await import("../server.js");

const rateHeaders = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4990",
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "x-ratelimit-resource": "core"
};

test("a missing or blank reason is refused before any GitHub call", () => {
  for (const value of [undefined, null, "", "   ", "\n\t"]) {
    assert.throws(
      () => normalizeCloseReason(value),
      (error) => error.status === 400 && /reason is required/i.test(error.message)
    );
  }
  assert.equal(normalizeCloseReason("  stale duplicate  "), "stale duplicate");
  assert.throws(
    () => normalizeCloseReason("x".repeat(501)),
    (error) => error.status === 400 && /500 characters/i.test(error.message)
  );
});

test("the audit comment names the operator and the reason", () => {
  assert.equal(
    closeAuditComment("stale duplicate", "cigan1"),
    "Closed via github-monitor (cigan1): stale duplicate"
  );
  assert.equal(dashboardOperator(), "cigan1");
});

test("the comment is posted before the close, and the close carries the state", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({
      path: requestUrl.pathname,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null
    });
    const isComment = requestUrl.pathname.endsWith("/comments");
    return new Response(
      JSON.stringify(isComment ? { id: 1, body: "comment" } : { state: "closed", number: 12 }),
      { status: isComment ? 201 : 200, headers: rateHeaders }
    );
  };
  try {
    const { result, comment } = await closePullRequestWithReason(
      "acme/app", 12, "stale duplicate", "cigan1"
    );
    assert.equal(result.state, "closed");
    assert.equal(comment, "Closed via github-monitor (cigan1): stale duplicate");
    assert.deepEqual(calls, [
      {
        path: "/repos/acme/app/issues/12/comments",
        method: "POST",
        body: { body: "Closed via github-monitor (cigan1): stale duplicate" }
      },
      {
        path: "/repos/acme/app/pulls/12",
        method: "PATCH",
        body: { state: "closed" }
      }
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the close endpoint rejects a missing reason without touching GitHub", async () => {
  const previousFetch = globalThis.fetch;
  let githubCalls = 0;
  globalThis.fetch = async () => {
    githubCalls += 1;
    throw new Error("GitHub must not be called for an invalid close");
  };
  const listener = await new Promise((resolve) => {
    const started = server.listen(0, "127.0.0.1", () => resolve(started));
  });
  try {
    const { port } = listener.address();
    for (const body of [
      { repo: "acme/app", number: 12 },
      { repo: "acme/app", number: 12, reason: "   " }
    ]) {
      const response = await previousFetch(`http://127.0.0.1:${port}/api/pull-request/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /reason is required/i);
    }
    assert.equal(githubCalls, 0);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
  }
});
