// Auto merge is one setting per server. A page load must read it, not set it:
// when every load re-sent its own accounts, a second tab or a headless check
// silently re-scoped auto merge and a green PR sat unmerged. The setting is
// saved to disk so a restart keeps it instead of waiting for a page to re-send.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const stateDir = mkdtempSync(path.join(tmpdir(), "auto-merge-scope-"));
const statePath = path.join(stateDir, "auto-merge.json");
process.env.AUTO_MERGE_STATE_PATH = statePath;
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";

const { server, loadAutoMergeStateFromDisk } = await import("../server.js");
const realFetch = globalThis.fetch;

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

async function withServer(fn) {
  const listener = await new Promise((resolve) => {
    const started = server.listen(0, "127.0.0.1", () => resolve(started));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

test("a saved auto merge setting survives a restart", async () => {
  await withServer(async (base) => {
    const before = await (await realFetch(`${base}/api/auto-merge`)).json();
    assert.equal(before.configured, false, "nothing is saved yet");

    // enabled:false keeps the server from starting a live scan against GitHub.
    const response = await realFetch(`${base}/api/auto-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, mode: "owned", jobs: 4, owners: ["cigan1", "ryabinski-labs"] })
    });
    const after = await response.json();
    assert.equal(after.configured, true);
  });

  const saved = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(
    { version: saved.version, enabled: saved.enabled, mode: saved.mode, owners: saved.owners },
    { version: 1, enabled: false, mode: "owned", owners: ["cigan1", "ryabinski-labs"] }
  );

  // What a restart does before the first page loads.
  writeFileSync(statePath, JSON.stringify({ ...saved, enabled: false, owners: ["ryabinski-labs"] }));
  assert.equal(loadAutoMergeStateFromDisk(statePath), true);
  await withServer(async (base) => {
    const restored = await (await realFetch(`${base}/api/auto-merge`)).json();
    assert.equal(restored.configured, true);
    assert.equal(restored.mode, "owned");
    assert.deepEqual(restored.owners, ["ryabinski-labs"]);
  });
});

test("a missing or foreign state file leaves auto merge unconfigured", () => {
  assert.equal(loadAutoMergeStateFromDisk(path.join(stateDir, "absent.json")), false);
  const foreign = path.join(stateDir, "foreign.json");
  writeFileSync(foreign, JSON.stringify({ version: 99, enabled: true }));
  assert.equal(loadAutoMergeStateFromDisk(foreign), false);
});

// --- page load -----------------------------------------------------------------

let browserMissing = false;
try {
  browserMissing = !existsSync(chromium.executablePath());
} catch {
  browserMissing = true;
}
const skip = browserMissing ? "Playwright Chromium not installed — run: npx playwright install chromium" : false;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const asset = (name) => readFileSync(path.join(publicDir, name), "utf8");

async function loadPage({ serverAutoMerge, storedSettings }) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const posts = [];
  await page.addInitScript((settings) => {
    localStorage.clear();
    localStorage.setItem("pr-deck:v1", JSON.stringify(settings));
  }, storedSettings);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    if (p === "/" || p === "/index.html") return route.fulfill({ contentType: "text/html", body: asset("index.html") });
    if (p === "/app.js") return route.fulfill({ contentType: "text/javascript", body: asset("app.js") });
    if (p === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: asset("theme.js") });
    if (p === "/styles.css") return route.fulfill({ contentType: "text/css", body: asset("styles.css") });
    if (p === "/api/auto-merge") {
      if (request.method() !== "GET") {
        const body = JSON.parse(request.postData() || "{}");
        posts.push(body);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...body, configured: true, running: false, candidates: [] }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(serverAutoMerge) });
    }
    if (p === "/api/status") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ account: "acme", accounts: ["cigan1", "ryabinski-labs"], warnings: [], options: {}, autoMerge: serverAutoMerge, summary: {}, pullRequests: {}, actions: {}, cd: {} })
      });
    }
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForSelector("#content");
  await page.waitForTimeout(500);
  return { browser, page, posts };
}

test("loading a page does not re-scope a configured auto merge", { skip }, async () => {
  const { browser, page, posts } = await loadPage({
    serverAutoMerge: { enabled: true, configured: true, mode: "all", jobs: 4, owners: ["cigan1", "ryabinski-labs"], running: false, candidates: [] },
    // The headless check that caused this: different accounts, auto merge on.
    storedSettings: { owners: ["GipsyChef", "cigan1"], autoMerge: true }
  });
  try {
    assert.deepEqual(posts, [], "page load must not send its own auto merge settings");
    assert.equal(await page.locator("#autoMerge").isChecked(), true, "the switch shows the server's setting");
  } finally {
    await browser.close();
  }
});

test("the switch follows the server, not the page's stored copy", { skip }, async () => {
  const { browser, page, posts } = await loadPage({
    serverAutoMerge: { enabled: false, configured: true, mode: "all", jobs: 4, owners: [], running: false, candidates: [] },
    storedSettings: { autoMerge: true }
  });
  try {
    assert.deepEqual(posts, []);
    assert.equal(await page.locator("#autoMerge").isChecked(), false);
  } finally {
    await browser.close();
  }
});

test("a server with nothing saved is seeded by the first page", { skip }, async () => {
  const { browser, posts } = await loadPage({
    serverAutoMerge: { enabled: false, configured: false, mode: "all", jobs: 4, owners: [], running: false, candidates: [] },
    storedSettings: { owners: ["ryabinski-labs"], autoMerge: true }
  });
  try {
    assert.equal(posts.length, 1);
    assert.equal(posts[0].enabled, true);
    assert.deepEqual(posts[0].owners, ["ryabinski-labs"]);
  } finally {
    await browser.close();
  }
});

// --- boot ------------------------------------------------------------------------

test("a server with nothing saved boots with auto merge on, still open to a page's scope", async () => {
  const { restoreAutoMergeAtBoot } = await import("../server.js");
  assert.equal(restoreAutoMergeAtBoot(path.join(stateDir, "never-saved.json")), "on by default");
  await withServer(async (base) => {
    const snapshot = await (await realFetch(`${base}/api/auto-merge`)).json();
    assert.equal(snapshot.enabled, true, "on by default");
    assert.equal(snapshot.configured, false, "the first page still sets the accounts");
  });
});

test("a saved off survives a restart instead of being reset to the default", async () => {
  const { restoreAutoMergeAtBoot } = await import("../server.js");
  const saved = path.join(stateDir, "saved-off.json");
  writeFileSync(saved, JSON.stringify({ version: 1, enabled: false, mode: "all", jobs: 4, owners: ["cigan1"] }));
  assert.equal(restoreAutoMergeAtBoot(saved), "restored");
  await withServer(async (base) => {
    const snapshot = await (await realFetch(`${base}/api/auto-merge`)).json();
    assert.equal(snapshot.enabled, false);
    assert.deepEqual(snapshot.owners, ["cigan1"]);
  });
});
