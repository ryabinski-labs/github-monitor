// CD, Runners and Auto (refresh) start on for a fresh dashboard and reset to on
// every restart because they are deliberately not persisted. Auto merge now
// starts off and Notify still starts on; both are persisted, so an explicit
// choice has to survive a reload. That distinction is the point of the last
// tests here.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

let browserMissing = false;
try {
  browserMissing = !existsSync(chromium.executablePath());
} catch {
  browserMissing = true;
}
const skip = browserMissing
  ? "Playwright Chromium not installed — run: npx playwright install chromium"
  : false;

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const asset = (name) => readFileSync(path.join(publicDir, name), "utf8");

const statusFixture = {
  account: "acme",
  accounts: ["acme"],
  generatedAt: "2026-09-06T12:00:00Z",
  warnings: [],
  options: {},
  autoMerge: { enabled: false, running: false, candidates: [] },
  scan: { reposConsidered: 1, reposScanned: 1, reposSkipped: 0, pushedWithinHours: 168, repoFloor: 10 },
  summary: {
    repos: 1,
    passingPrs: 0, noCiPrs: 0, failingPrs: 0, conflictPrs: 0, runningPrs: 0,
    runningCd: 0, finishedCd: 0, failedCd: 0, skippedCd: 0,
    runningDeployments: 0, busyRunners: 0,
    flaggedJourneys: 0, activeJourneys: 0, shippedJourneys: 0, tracingUnknown: 0
  },
  pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
  actions: { failed: [], running: [] },
  cd: { running: [], finished: [], failed: [] },
  deployments: { running: [] },
  runners: { busy: [] },
  traces: { flagged: [], active: [], completed: [], unknown: [] },
  refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
  rateLimit: { core: { remaining: 5000, limit: 5000 } }
};

// storedSettings === null means a brand-new dashboard (nothing in localStorage).
async function openDashboard({ storedSettings = null } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const seen = { statusQueries: [], autoMergeBodies: [] };
  // The server owns auto-merge state and echoes it back on /api/status, which
  // the client then applies. Mirror that here so the two mocked endpoints do
  // not contradict each other.
  let autoMergeEnabled = false;

  await page.addInitScript((settings) => {
    localStorage.clear();
    if (settings) localStorage.setItem("pr-deck:v1", JSON.stringify(settings));
    // chrome-headless-shell ships no Notification API, which would disable the
    // Notify switch for reasons unrelated to its default.
    window.Notification = { permission: "granted", requestPermission: async () => "granted" };
  }, storedSettings);

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return route.fulfill({ contentType: "text/html", body: asset("index.html") });
    if (p === "/app.js") return route.fulfill({ contentType: "text/javascript", body: asset("app.js") });
    if (p === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: asset("theme.js") });
    if (p === "/styles.css") return route.fulfill({ contentType: "text/css", body: asset("styles.css") });
    if (p === "/api/status") {
      seen.statusQueries.push(url.search);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...statusFixture,
          autoMerge: { ...statusFixture.autoMerge, enabled: autoMergeEnabled }
        })
      });
    }
    if (p === "/api/auto-merge") {
      // A fresh server has nothing saved, so the page seeds it with a POST.
      if (route.request().method() === "GET") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ enabled: false, configured: false, running: false, candidates: [] })
        });
      }
      const body = JSON.parse(route.request().postData() || "{}");
      seen.autoMergeBodies.push(body);
      autoMergeEnabled = Boolean(body.enabled);
      // Echo the request the way the server does, so the client's checkbox
      // reflects what auto merge was actually set to.
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ enabled: Boolean(body.enabled), running: false, candidates: [] })
      });
    }
    if (p === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("#content");
  return { browser, page, seen };
}

const checked = (page, id) => page.locator(`#${id}`).isChecked();

test("a fresh dashboard starts with refresh, CD, runners and notify on, auto merge off", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    for (const id of ["includeCd", "includeRunners", "autoRefresh", "notifications"]) {
      assert.equal(await checked(page, id), true, `${id} should default to on`);
    }
    assert.equal(await checked(page, "autoMerge"), false, "auto merge must be an explicit opt-in");
  } finally {
    await browser.close();
  }
});

test("the default switches reach the server on the first scan", { skip }, async () => {
  const { browser, page, seen } = await openDashboard();
  try {
    await page.waitForFunction(() => document.querySelector("#account")?.textContent === "acme");
    assert.ok(seen.statusQueries.length >= 1, "a status scan was requested");
    assert.match(seen.statusQueries[0], /includeCd=1/);
    assert.match(seen.statusQueries[0], /includeRunners=1/);

    assert.ok(seen.autoMergeBodies.length >= 1, "auto merge was configured");
    assert.equal(seen.autoMergeBodies[0].enabled, false, "the server is not asked to merge by default");
  } finally {
    await browser.close();
  }
});

test("CD, Runners and Auto refresh reset to on after a restart, whatever was toggled before", { skip }, async () => {
  // These three are intentionally not persisted, so a stored blob that predates
  // this default -- or any blob at all -- must not hold them off.
  const { browser, page } = await openDashboard({
    storedSettings: { view: "fail", theme: "dark", autoMerge: true, notifications: true }
  });
  try {
    for (const id of ["includeCd", "includeRunners", "autoRefresh"]) {
      assert.equal(await checked(page, id), true, `${id} should come back on`);
    }
  } finally {
    await browser.close();
  }
});

test("an explicit opt-out of auto merge or notifications survives a restart", { skip }, async () => {
  const { browser, page, seen } = await openDashboard({
    storedSettings: { view: "fail", theme: "dark", autoMerge: false, notifications: false }
  });
  try {
    assert.equal(await checked(page, "autoMerge"), false, "auto merge stays off once turned off");
    assert.equal(await checked(page, "notifications"), false, "notifications stay off once turned off");
    // and the server is told to keep auto merge off, not just the checkbox.
    await page.waitForFunction(() => document.querySelector("#account")?.textContent === "acme");
    assert.equal(seen.autoMergeBodies[0].enabled, false);
  } finally {
    await browser.close();
  }
});
