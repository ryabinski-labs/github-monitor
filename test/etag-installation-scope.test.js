import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every GitHub App installation lists its repos at the same URL,
// /installation/repositories. These scenarios pin that the conditional-request
// cache keeps those responses apart per installation, and that a 304 only ever
// returns the body for the ETag the request actually sent (TDD artifact
// tdd/installation-repo-listing-cache.tdd.yaml).

// App auth is decided at module load. Set env BEFORE importing server.js.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const tmpDir = mkdtempSync(join(tmpdir(), "ghmon-etag-scope-"));
const pemPath = join(tmpDir, "key.pem");
writeFileSync(pemPath, pem, { mode: 0o600 });
chmodSync(pemPath, 0o600);

process.env.GITHUB_APP_ID = "999999";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const {
  server,
  etagCache,
  fetchOwnerRepos,
  resetGithubValueCache,
  resetLastKnownOwnerRepos
} = await import("../server.js");

const realFetch = globalThis.fetch;
const LISTING_URL = "https://api.github.com/installation/repositories?per_page=100&page=1";
const ME = "GipsyChef";

const INSTALLATIONS = [
  { id: 2001, login: "cigan1", type: "User" },
  { id: 2002, login: "ryabinski-labs", type: "Organization" }
];
const tokenFor = (id) => `token-for-${id}`;
const ownerForToken = (token) => INSTALLATIONS.find((inst) => tokenFor(inst.id) === token)?.login || null;

function headers(resource = "core", etag) {
  return {
    "content-type": "application/json",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4990",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": resource,
    ...(etag ? { etag } : {})
  };
}

function repo(fullName) {
  return { full_name: fullName, archived: false, pushed_at: new Date().toISOString(), owner: { login: fullName.split("/")[0] } };
}

// A fake GitHub that honours conditional requests per token: an If-None-Match
// equal to the ETag of the caller's current listing is a 304, anything else a
// 200 with the caller's own repos. `hold` lets a test deliver one response late.
function fakeGithub({ extra } = {}) {
  const listings = new Map([
    ["cigan1", { etag: 'W/"cigan1-v1"', repos: ["cigan1/leafread", "cigan1/homebrew-tap"] }],
    ["ryabinski-labs", { etag: 'W/"ryab-v1"', repos: ["ryabinski-labs/Sendant", "ryabinski-labs/bev"] }]
  ]);
  const log = [];
  const holds = [];
  const fake = {
    listings,
    log,
    setListing(owner, etag, repos) {
      listings.set(owner, { etag, repos });
    },
    // The next listing request from `owner` is answered as of now, but only
    // delivered when the returned release() is called.
    holdNext(owner) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let seen;
      const sent = new Promise((resolve) => { seen = resolve; });
      holds.push({ owner, gate, seen });
      return { release, sent };
    },
    failNext(owner, status = 502) {
      holds.push({ owner, fail: status });
    },
    listingRequests(owner) {
      return log.filter((entry) => entry.path === "/installation/repositories" && entry.owner === owner);
    }
  };
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    const token = String(options.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    const owner = ownerForToken(token);
    const ifNoneMatch = options.headers?.["if-none-match"] || null;

    if (path === "/app/installations") {
      return Response.json(
        INSTALLATIONS.map((inst) => ({ id: inst.id, account: { login: inst.login, type: inst.type }, repository_selection: "all" })),
        { headers: headers() }
      );
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (tokenMatch) {
      return Response.json(
        { token: tokenFor(Number(tokenMatch[1])), expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { headers: headers() }
      );
    }
    if (path === "/installation/repositories") {
      log.push({ path, owner, ifNoneMatch });
      const holdIndex = holds.findIndex((hold) => hold.owner === owner);
      const hold = holdIndex >= 0 ? holds.splice(holdIndex, 1)[0] : null;
      if (hold?.fail) return Response.json({ message: "Server Error" }, { status: hold.fail, headers: headers() });
      const listing = listings.get(owner);
      const response = ifNoneMatch && ifNoneMatch === listing.etag
        ? new Response(null, { status: 304, headers: headers("core", listing.etag) })
        : Response.json(
          { total_count: listing.repos.length, repositories: listing.repos.map(repo) },
          { headers: headers("core", listing.etag) }
        );
      if (hold) {
        hold.seen();
        await hold.gate;
      }
      return response;
    }
    if (extra) {
      const handled = await extra(path, { owner, requestUrl, options });
      if (handled) return handled;
    }
    return Response.json({ message: "Not Found" }, { status: 404, headers: headers() });
  };
  return fake;
}

function reset() {
  etagCache.clear();
  resetGithubValueCache();
  resetLastKnownOwnerRepos();
}

const names = (repos) => repos.map((entry) => entry.fullName).sort();

test("SC-key-separate-slots: two installations listing the same URL keep separate cache entries", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; reset(); });
  reset();
  fakeGithub();
  await fetchOwnerRepos("cigan1", ME);
  await fetchOwnerRepos("ryabinski-labs", ME);

  const cigan1 = etagCache.get(`cigan1 ${LISTING_URL}`);
  const ryab = etagCache.get(`ryabinski-labs ${LISTING_URL}`);
  assert.ok(cigan1, `expected a cigan1 entry, keys: ${JSON.stringify([...etagCache.keys()])}`);
  assert.ok(ryab, `expected a ryabinski-labs entry, keys: ${JSON.stringify([...etagCache.keys()])}`);
  assert.deepEqual(cigan1.body.repositories.map((r) => r.owner.login), ["cigan1", "cigan1"]);
  assert.deepEqual(ryab.body.repositories.map((r) => r.owner.login), ["ryabinski-labs", "ryabinski-labs"]);
});

test("SC-race-304-own-body: a 304 that lands after another installation's 200 returns the requester's own repos", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; reset(); });
  reset();
  const github = fakeGithub();
  // Prime both listings; ryabinski-labs last, as in the 16:36 UTC scan.
  await fetchOwnerRepos("cigan1", ME);
  await fetchOwnerRepos("ryabinski-labs", ME);
  resetGithubValueCache();

  // ryabinski-labs' conditional request is answered 304 but delivered late...
  const held = github.holdNext("ryabinski-labs");
  const ryabPending = fetchOwnerRepos("ryabinski-labs", ME);
  await held.sent;
  // ...while cigan1's listing changed, so its 200 lands first.
  github.setListing("cigan1", 'W/"cigan1-v2"', ["cigan1/leafread", "cigan1/homebrew-tap", "cigan1/new"]);
  await fetchOwnerRepos("cigan1", ME);
  held.release();

  assert.deepEqual(names(await ryabPending), ["ryabinski-labs/Sendant", "ryabinski-labs/bev"]);
});

test("SC-304-match-no-extra: a matching 304 returns the cached body with no extra request", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; reset(); });
  reset();
  const github = fakeGithub();
  const firstCigan1 = await fetchOwnerRepos("cigan1", ME);
  const firstRyab = await fetchOwnerRepos("ryabinski-labs", ME);
  resetGithubValueCache();
  const before = github.log.length;

  const secondCigan1 = await fetchOwnerRepos("cigan1", ME);
  const secondRyab = await fetchOwnerRepos("ryabinski-labs", ME);

  const refetches = github.log.slice(before);
  assert.equal(github.listingRequests("cigan1").length, 2, "one listing request per cigan1 fetch");
  assert.equal(github.listingRequests("ryabinski-labs").length, 2, "one listing request per ryabinski-labs fetch");
  assert.ok(
    refetches.every((entry) => entry.ifNoneMatch === github.listings.get(entry.owner).etag),
    `every refetch must send its own installation's ETag so GitHub answers 304: ${JSON.stringify(refetches)}`
  );
  assert.deepEqual(names(secondCigan1), names(firstCigan1));
  assert.deepEqual(names(secondRyab), names(firstRyab));
});

test("SC-304-mismatch-refetches: a 304 whose ETag no longer matches the slot triggers one unconditional refetch", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; reset(); });
  reset();
  const github = fakeGithub();
  await fetchOwnerRepos("ryabinski-labs", "viewer-a");
  resetGithubValueCache();

  // Request B reaches GitHub first and is answered 304 for E1, but delivered late.
  const held = github.holdNext("ryabinski-labs");
  const pendingB = fetchOwnerRepos("ryabinski-labs", "viewer-b");
  await held.sent;
  // The listing moves on; request A also sent E1, gets a 200 with E2, and is stored.
  github.setListing("ryabinski-labs", 'W/"ryab-v2"', ["ryabinski-labs/Sendant", "ryabinski-labs/bev", "ryabinski-labs/v2"]);
  await fetchOwnerRepos("ryabinski-labs", "viewer-a");
  // By the time B's 304 lands, the listing has moved again.
  github.setListing("ryabinski-labs", 'W/"ryab-v3"', ["ryabinski-labs/Sendant", "ryabinski-labs/v3"]);
  held.release();
  const resultB = await pendingB;

  const requests = github.listingRequests("ryabinski-labs");
  assert.equal(requests.length, 4, `expected prime, B, A and one unconditional retry: ${JSON.stringify(requests)}`);
  assert.equal(requests[3].ifNoneMatch, null, "the retry must not be conditional");
  assert.deepEqual(names(resultB), ["ryabinski-labs/Sendant", "ryabinski-labs/v3"]);
  assert.equal(etagCache.get(`ryabinski-labs ${LISTING_URL}`)?.etag, 'W/"ryab-v3"');
});

test("SC-304-retry-fails-falls-back: a failed unconditional retry surfaces as a listing failure and keeps the last-known list", async (t) => {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); };
  t.after(() => { console.error = realError; globalThis.fetch = realFetch; reset(); });
  reset();
  const github = fakeGithub();
  const lastKnown = await fetchOwnerRepos("ryabinski-labs", "viewer-b");
  resetGithubValueCache();

  const held = github.holdNext("ryabinski-labs");
  const pendingB = fetchOwnerRepos("ryabinski-labs", "viewer-b");
  await held.sent;
  github.setListing("ryabinski-labs", 'W/"ryab-v2"', ["ryabinski-labs/v2-only"]);
  await fetchOwnerRepos("ryabinski-labs", "viewer-a");
  github.failNext("ryabinski-labs", 502);
  held.release();
  const resultB = await pendingB;

  assert.deepEqual(names(resultB), names(lastKnown), "the last-known list is kept, not another response's body");
  assert.ok(
    logged.some((line) => line.includes("listing ryabinski-labs repositories failed") && line.includes("(using last known list)")),
    `expected the listing-failure log line, got: ${JSON.stringify(logged)}`
  );
});

// The dashboard journey from the incident: a running iOS CD in a repo with no
// open PR, owners cigan1 + ryabinski-labs, and the two listings racing.
test("SC-running-cd-survives-race: Sendant's running iOS CD stays on the dashboard through the listing race", async (t) => {
  const runs = {
    workflow_runs: [{
      id: 36333230167,
      name: "iOS 1.0.7 (26) · testflight",
      path: ".github/workflows/ios-cd.yml",
      run_number: 26,
      status: "in_progress",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "80c64e36bede30e3bb0aeccbcc23fe40316fbd2d",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pull_requests: [],
      html_url: "https://github.com/ryabinski-labs/Sendant/actions/runs/36333230167"
    }]
  };
  const github = fakeGithub({
    extra: async (path) => {
      if (path === "/graphql") {
        return Response.json({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }, { headers: headers("graphql") });
      }
      if (path === "/repos/ryabinski-labs/Sendant/actions/runs") return Response.json(runs, { headers: headers() });
      if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(path)) return Response.json({ workflow_runs: [] }, { headers: headers() });
      if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(path)) return Response.json({ workflows: [] }, { headers: headers() });
      if (/^\/repos\/[^/]+\/[^/]+\/deployments$/.test(path)) return Response.json([], { headers: headers() });
      return null;
    }
  });
  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve) => testServer.close(resolve));
    globalThis.fetch = realFetch;
    reset();
  });
  reset();
  const { port } = testServer.address();
  const status = async () => {
    resetGithubValueCache();
    const response = await realFetch(
      `http://127.0.0.1:${port}/api/status?mode=all&owners=cigan1,ryabinski-labs&includeCd=1&includeRunners=0&jobs=4`
    );
    return response.json();
  };

  const first = await status();
  assert.ok(first.cd.running.some((run) => run.repo === "ryabinski-labs/Sendant"), "the first scan sees the run");

  // Second scan: cigan1's listing changed, and its 200 lands while
  // ryabinski-labs' 304 is still in flight.
  github.setListing("cigan1", 'W/"cigan1-v2"', ["cigan1/leafread", "cigan1/homebrew-tap", "cigan1/new"]);
  const held = github.holdNext("ryabinski-labs");
  const secondPending = status();
  await held.sent;
  while (github.listingRequests("cigan1").length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  held.release();
  const second = await secondPending;

  assert.ok(
    second.cd.running.some((run) => run.repo === "ryabinski-labs/Sendant"),
    `the Sendant run must survive the race; running: ${JSON.stringify(second.cd.running)}, scan: ${JSON.stringify(second.scan)}`
  );
  assert.equal(second.summary.runningCd, 1);
});
