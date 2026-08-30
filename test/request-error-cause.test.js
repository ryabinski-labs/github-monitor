import test from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";
// Keeps the token path off `gh auth token`, which would shell out from a test.
process.env.GITHUB_TOKEN = "test-token";

const { describeRequestError, server } = await import("../server.js");

// undici's shape: a bare TypeError whose `cause` carries everything useful.
function fetchFailed(cause) {
  const error = new TypeError("fetch failed");
  error.cause = cause;
  return error;
}

test("a network failure names the reason instead of just 'fetch failed'", () => {
  // The dashboard warning that prompted this read `GipsyChef repositories:
  // fetch failed` -- true, and useless. It does not distinguish a DNS outage
  // from a reset socket from an expired certificate, which are three different
  // things to go do.
  const cause = Object.assign(new Error("connect ECONNREFUSED 140.82.121.6:443"), {
    code: "ECONNREFUSED"
  });
  assert.equal(
    describeRequestError(fetchFailed(cause)),
    "fetch failed: connect ECONNREFUSED 140.82.121.6:443 (ECONNREFUSED)"
  );
});

test("a DNS failure and a reset socket no longer read identically", () => {
  const dns = describeRequestError(
    fetchFailed(Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }))
  );
  const reset = describeRequestError(
    fetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
  );

  assert.notEqual(dns, reset, "the whole point: two causes, two messages");
  assert.match(dns, /ENOTFOUND/);
  assert.match(reset, /ECONNRESET/);
});

test("a multi-address connect keeps its real failure on errors, not cause", () => {
  // Node tries every A/AAAA record and reports an AggregateError. The reason
  // lives on `errors`; reading only `cause` would stop at the wrapper.
  const aggregate = new AggregateError(
    [Object.assign(new Error("connect ETIMEDOUT 140.82.121.6:443"), { code: "ETIMEDOUT" })],
    "all connection attempts failed"
  );
  const described = describeRequestError(fetchFailed(aggregate));

  assert.match(described, /all connection attempts failed/);
  assert.match(described, /ETIMEDOUT/);
});

test("a chain deeper than two levels is followed to the bottom", () => {
  const root = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
  const middle = Object.assign(new Error("TLS handshake failed"), { cause: root });
  assert.equal(
    describeRequestError(fetchFailed(middle)),
    "fetch failed: TLS handshake failed: certificate has expired (CERT_HAS_EXPIRED)"
  );
});

test("an error that already says something useful is left alone", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError"
  });
  assert.equal(describeRequestError(timeout), "The operation was aborted due to timeout");

  const http = new Error("GitHub API returned 403");
  assert.equal(describeRequestError(http), "GitHub API returned 403");
});

test("a repeated message is not printed twice", () => {
  const cause = new Error("fetch failed");
  assert.equal(describeRequestError(fetchFailed(cause)), "fetch failed");
});

test("a self-referential cause cannot spin", () => {
  const looped = new Error("looping");
  looped.cause = looped;
  assert.equal(describeRequestError(looped), "looping");

  const a = new Error("a");
  const b = new Error("b");
  a.cause = b;
  b.cause = a;
  assert.equal(describeRequestError(a), "a: b");
});

test("a thrown non-object does not produce an empty warning", () => {
  assert.equal(describeRequestError(null), "unknown error");
  assert.equal(describeRequestError(undefined), "unknown error");
  assert.equal(describeRequestError("just a string"), "unknown error");
});

// --- the call sites actually use it --------------------------------------------

test("a scan surfaces the cause end to end, not just in the helper", async () => {
  // The helper being correct proves nothing on its own: the bug was that the
  // fetch call sites never consulted `cause`. This drives a real request through
  // the real route with the network failing underneath it.
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("connect ECONNREFUSED 140.82.121.6:443"), {
      code: "ECONNREFUSED"
    });
    throw error;
  };

  const listener = await new Promise((resolve) => {
    const l = server.listen(0, "127.0.0.1", () => resolve(l));
  });
  try {
    const { port } = listener.address();
    const response = await previousFetch(
      `http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`
    );
    const body = await response.json();

    assert.match(body.error, /ECONNREFUSED/, `the cause reached the caller: ${body.error}`);
    assert.notEqual(body.error, "fetch failed", "the bare wrapper is what this replaces");
  } finally {
    globalThis.fetch = previousFetch;
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
});
