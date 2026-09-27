import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// PAT half of tdd/installation-repo-listing-cache.tdd.yaml: the cache key
// carries `pat` when there is no App installation, and the persisted file moves
// to version 2 so the pre-fix shared /installation/repositories entry is never
// restored. App auth is decided at module load, hence a file of its own.

process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";
process.env.GITHUB_TOKEN = "test-token";

const {
  etagCache,
  fetchOwnerRepos,
  loadEtagCacheFromDisk,
  saveEtagCacheToDisk,
  resetGithubValueCache,
  resetLastKnownOwnerRepos
} = await import("../server.js");

const realFetch = globalThis.fetch;
const LISTING_URL = "https://api.github.com/installation/repositories?per_page=100&page=1";

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "etag-scope-"));
  return { file: path.join(dir, "etag-cache.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("SC-pat-key: PAT mode keys entries with pat", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
    etagCache.clear();
    resetGithubValueCache();
    resetLastKnownOwnerRepos();
  });
  etagCache.clear();
  globalThis.fetch = async () => Response.json(
    [{ full_name: "maintainer/app", archived: false, pushed_at: new Date().toISOString(), owner: { login: "maintainer" } }],
    { headers: { "content-type": "application/json", etag: 'W/"repos"', "x-ratelimit-resource": "core" } }
  );
  await fetchOwnerRepos("maintainer", "maintainer");

  const keys = [...etagCache.keys()];
  assert.ok(keys.length > 0, "the listing was cached");
  assert.ok(keys.every((key) => key.startsWith("pat https://api.github.com/")), `keys: ${JSON.stringify(keys)}`);
});

test("SC-v1-file-discarded: a version 1 cache file loads no entries", (t) => {
  const { file, cleanup } = tempFile();
  t.after(() => { cleanup(); etagCache.clear(); });
  writeFileSync(file, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    entries: [{ url: LISTING_URL, etag: 'W/"shared"', body: { repositories: [] }, usedAt: Date.now() }]
  }));
  etagCache.clear();

  assert.equal(loadEtagCacheFromDisk(file), 0);
  assert.equal(etagCache.size, 0);
});

test("SC-v2-roundtrip: a version 2 file round-trips installation-prefixed keys", async (t) => {
  const { file, cleanup } = tempFile();
  t.after(() => { cleanup(); etagCache.clear(); });
  const key = `ryabinski-labs ${LISTING_URL}`;
  const store = new Map([[key, { etag: 'W/"ryab"', body: { repositories: [] }, usedAt: Date.now() }]]);

  assert.equal(await saveEtagCacheToDisk(file, store), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2);
  etagCache.clear();
  assert.equal(loadEtagCacheFromDisk(file), 1);
  assert.ok(etagCache.has(key), `restored keys: ${JSON.stringify([...etagCache.keys()])}`);
});
