import test from "node:test";
import assert from "node:assert/strict";

// Read at import time. A developer's .env would otherwise decide what authMode
// reports, and server.js only skips .env when NODE_ENV=test -- so pin it here
// rather than relying on how the suite happens to be invoked.
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";

const {
  quotaSnapshot,
  snapshotRateLimit,
  recordRateLimit,
  resetObservedRateBuckets,
  createScanMetrics,
  currentQuotaIsBlocked,
  partialScanCause,
  scanMetrics,
  server
} = await import("../server.js");

function fakeResponse({ limit, remaining, reset, resource = "core", used }) {
  const headers = new Map([
    ["x-ratelimit-limit", String(limit)],
    ["x-ratelimit-remaining", String(remaining)],
    ["x-ratelimit-reset", String(reset)],
    ["x-ratelimit-resource", resource]
  ]);
  if (used !== undefined) headers.set("x-ratelimit-used", String(used));
  return { headers: { get: (key) => headers.get(key) ?? null } };
}

const snapshotNow = () => quotaSnapshot(snapshotRateLimit(createScanMetrics()));

// --- a quota reading says which installation it describes ----------------------

test("a quota reading names the installation it came from", () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 7300, remaining: 6895, reset, used: 405 }), {
    installationKey: "ryabinski-labs"
  });

  const snap = snapshotNow();
  assert.equal(snap.installationKey, "ryabinski-labs");
  assert.equal(snap.limit, 7300);
  assert.equal(snap.resource, "core");
});

test("a limit that changes between polls is attributable to an account, not a credential", () => {
  // The bug this guards, observed live: readings appeared to thrash between
  // 7300, 5000 and 5100, which reads as a GitHub App silently downgrading to a
  // PAT's flat 5,000. It was nothing of the sort -- App auth mints one token per
  // owner and GitHub scales each separately, and `tightest` is chosen by
  // remaining-ratio across all of them, so consecutive polls legitimately
  // describe different accounts. Publishing `limit` without saying whose limit
  // it is, is what made a correct reading look like a fault.
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 7300, remaining: 6895, reset }), { installationKey: "ryabinski-labs" });
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 4990, reset }), { installationKey: "siftfy" });

  const first = snapshotNow();
  assert.equal(first.installationKey, "ryabinski-labs", "the lowest ratio wins, not the lowest limit");
  assert.equal(first.limit, 7300);

  // ryabinski-labs recovers past siftfy's ratio, so the tightest bucket moves.
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 1000, reset }), { installationKey: "siftfy" });
  const second = snapshotNow();

  assert.notEqual(second.limit, first.limit, "the published limit does change between polls");
  assert.notEqual(
    second.installationKey,
    first.installationKey,
    "and the field that explains why must change with it"
  );
  assert.equal(second.installationKey, "siftfy");
  assert.equal(second.limit, 5000);
});

test("an empty bucket cache reads as unknown rather than as an exhausted account", () => {
  resetObservedRateBuckets();
  const snap = snapshotNow();
  assert.equal(snap.status, "unknown");
  assert.equal(snap.blocked, false, "no data is not the same as no quota");
  assert.equal(snap.installationKey, "");
  assert.equal(snap.limit, null);
  assert.equal(snap.remaining, null);
});

// --- asking how much quota is left must not spend any --------------------------

async function withTestServer(run) {
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, "127.0.0.1", () => resolve(l));
  });
  try {
    return await run(listener.address().port);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  }
}

test("/api/health reports quota without making a single GitHub request", async () => {
  // The whole point of the endpoint. Every other route runs a scan, so before
  // this the only way to answer "how much headroom is left?" was to consume
  // some -- and repeated checks are how the account got drained in the first
  // place. A fetch of any kind here would restore that circularity.
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 7300, remaining: 756, reset, used: 6544 }), {
    installationKey: "ryabinski-labs"
  });
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 4990, reset }), { installationKey: "siftfy" });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`/api/health made a network request: ${url}`);
  };
  try {
    const data = await withTestServer(async (port) => {
      const response = await previousFetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      return response.json();
    });

    assert.equal(data.ok, true, "the liveness contract CI smoke-tests is unchanged");
    assert.equal(data.authMode, "pat", "app vars are cleared at the top of this file");
    assert.equal(data.quota.installationKey, "ryabinski-labs");
    assert.equal(data.quota.remaining, 756);
    assert.equal(data.quota.limit, 7300);

    // Every bucket, not just the tightest: one bucket alone is what makes a
    // multi-installation account look like it is thrashing.
    assert.equal(data.buckets.length, 2);
    assert.deepEqual(
      data.buckets.map((b) => b.installationKey).sort(),
      ["ryabinski-labs", "siftfy"]
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("/api/health still answers before any scan has run", async () => {
  // CI starts the server with no credentials and curls this endpoint. An empty
  // bucket cache must not turn that into a non-200.
  resetObservedRateBuckets();
  const previousFetch = globalThis.fetch;
  const data = await withTestServer(async (port) => {
    const response = await previousFetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    return response.json();
  });

  assert.equal(data.ok, true);
  assert.equal(data.quota.status, "unknown");
  assert.deepEqual(data.buckets, []);
});

// --- a partial scan says whether quota or latency stopped it -------------------

test("a partial scan caused by quota says so instead of blaming latency", () => {
  // The screenshot that prompted this: "Partial scan: cd did not finish" on its
  // own, with no quota line beside it. The quota line is suppressed once the
  // reading recovers to "ok" (buildDashboardWarnings returns early), and the
  // reset had landed by the time the banner rendered -- so the only surviving
  // message pointed at a slow scan when the cause was an exhausted budget.
  assert.equal(
    partialScanCause(3),
    "did not finish because the GitHub quota ran out, not because it was slow"
  );
  assert.equal(partialScanCause(1), partialScanCause(3), "one refusal is enough to name the cause");
});

test("a partial scan with quota to spare keeps the plain wording", () => {
  assert.equal(partialScanCause(0), "did not finish");
  assert.equal(partialScanCause(undefined), "did not finish", "an absent count is not a quota block");
});

test("a refused request is counted on the scan that was refused", async () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  // Exhausted: currentQuotaIsBlocked is what every scan gate consults.
  recordRateLimit(fakeResponse({ limit: 7300, remaining: 0, reset, used: 7300 }), {
    installationKey: "ryabinski-labs"
  });

  const metrics = createScanMetrics();
  assert.equal(metrics.quotaBlockedRequests, 0);
  await scanMetrics.run(metrics, async () => {
    assert.equal(currentQuotaIsBlocked(), true);
    assert.equal(currentQuotaIsBlocked(), true);
  });
  assert.equal(metrics.quotaBlockedRequests, 2, "each refusal is counted, not just the first");
  assert.equal(
    partialScanCause(metrics.quotaBlockedRequests),
    "did not finish because the GitHub quota ran out, not because it was slow"
  );
});

test("a healthy scan counts no refusals, so its wording stays unchanged", async () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 7300, remaining: 7000, reset, used: 300 }), {
    installationKey: "ryabinski-labs"
  });

  const metrics = createScanMetrics();
  await scanMetrics.run(metrics, async () => {
    assert.equal(currentQuotaIsBlocked(), false);
  });
  assert.equal(metrics.quotaBlockedRequests, 0);
  assert.equal(partialScanCause(metrics.quotaBlockedRequests), "did not finish");
});
