import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deserializeEtagCache,
  etagCache,
  loadEtagCacheFromDisk,
  pruneEtagCache,
  saveEtagCacheToDisk,
  serializeEtagCache
} from "../server.js";

function tempFile(name = "etag-cache.json") {
  const dir = mkdtempSync(path.join(tmpdir(), "etag-cache-"));
  return { dir, file: path.join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function entry(etag, body, usedAt = Date.now()) {
  return { etag, body, usedAt };
}

test("a cache survives a round trip through disk", async () => {
  const { file, cleanup } = tempFile();
  try {
    const store = new Map([
      ["https://api.github.com/repos/a/b/pulls", entry('W/"pulls"', [{ number: 1 }])],
      ["https://api.github.com/repos/a/b/actions/runs", entry('W/"runs"', { workflow_runs: [] })]
    ]);

    assert.equal(await saveEtagCacheToDisk(file, store), true);

    etagCache.clear();
    assert.equal(loadEtagCacheFromDisk(file), 2);
    assert.equal(etagCache.get("https://api.github.com/repos/a/b/pulls").etag, 'W/"pulls"');
    assert.deepEqual(etagCache.get("https://api.github.com/repos/a/b/pulls").body, [{ number: 1 }]);
    assert.deepEqual(etagCache.get("https://api.github.com/repos/a/b/actions/runs").body, { workflow_runs: [] });
  } finally {
    etagCache.clear();
    cleanup();
  }
});

test("an entry with no ETag is dropped, because it can never produce a 304", () => {
  const restored = deserializeEtagCache(JSON.stringify({
    version: 1,
    entries: [
      { url: "https://api/keep", etag: 'W/"x"', body: 1 },
      { url: "https://api/no-etag", etag: "", body: 2 },
      { url: "https://api/missing-etag", body: 3 },
      { etag: 'W/"y"', body: 4 }
    ]
  }));
  assert.deepEqual([...restored.keys()], ["https://api/keep"]);
});

test("an unreadable or foreign cache file starts cold instead of throwing", () => {
  const { file, cleanup } = tempFile();
  try {
    etagCache.clear();

    // Nothing on disk at all.
    assert.equal(loadEtagCacheFromDisk(path.join(file, "absent.json")), 0);

    // Truncated by a crash mid-write.
    writeFileSync(file, '{"version":1,"entries":[{"url"');
    assert.equal(loadEtagCacheFromDisk(file), 0);

    // A future format this build does not understand.
    writeFileSync(file, JSON.stringify({ version: 99, entries: [{ url: "u", etag: "e", body: 1 }] }));
    assert.equal(loadEtagCacheFromDisk(file), 0);

    assert.equal(etagCache.size, 0);
  } finally {
    etagCache.clear();
    cleanup();
  }
});

test("eviction keeps the most recently used entries", () => {
  const store = new Map([
    ["oldest", entry("e1", "a", 1000)],
    ["middle", entry("e2", "b", 2000)],
    ["newest", entry("e3", "c", 3000)]
  ]);
  const { entries } = pruneEtagCache(store, { maxEntries: 2, maxBytes: Infinity });
  assert.deepEqual(entries.map(([url]) => url), ["newest", "middle"]);
});

test("a byte ceiling keeps the cache from growing without bound", () => {
  const big = "x".repeat(5000);
  const store = new Map([
    ["https://api/one", entry("e1", big, 3000)],
    ["https://api/two", entry("e2", big, 2000)],
    ["https://api/three", entry("e3", big, 1000)]
  ]);
  const { entries, bytes } = pruneEtagCache(store, { maxEntries: 100, maxBytes: 11000 });
  assert.equal(entries.length, 2, `two of three fit under the ceiling, got ${entries.length}`);
  assert.ok(bytes <= 11000, `stayed under the ceiling, got ${bytes}`);
  // Newest first, so the survivors are the ones a scan is most likely to reuse.
  assert.deepEqual(entries.map(([url]) => url), ["https://api/one", "https://api/two"]);
});

test("the written file is capped, not merely the in-memory copy", () => {
  const store = new Map();
  for (let index = 0; index < 50; index += 1) {
    store.set(`https://api/${index}`, entry(`e${index}`, "y".repeat(1000), index));
  }
  const written = JSON.parse(serializeEtagCache(store, { maxEntries: 5, maxBytes: Infinity }));
  assert.equal(written.entries.length, 5);
  assert.equal(written.version, 1);
  // Highest usedAt wins.
  assert.deepEqual(written.entries.map((e) => e.url), [
    "https://api/49",
    "https://api/48",
    "https://api/47",
    "https://api/46",
    "https://api/45"
  ]);
});

test("a save replaces the previous file atomically and leaves no temp behind", async () => {
  const { dir, file, cleanup } = tempFile();
  try {
    await saveEtagCacheToDisk(file, new Map([["https://api/first", entry("e1", "first")]]));
    await saveEtagCacheToDisk(file, new Map([["https://api/second", entry("e2", "second")]]));

    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(written.entries.map((e) => e.url), ["https://api/second"]);

    const strays = existsSync(dir)
      ? (await import("node:fs")).readdirSync(dir).filter((name) => name.includes(".tmp"))
      : [];
    assert.deepEqual(strays, [], "the write-then-rename left no partial file");
  } finally {
    etagCache.clear();
    cleanup();
  }
});
