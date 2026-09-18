// Regression coverage for server-side auto-dismissal of cancelled workflow runs.
//
// Reported symptom: cancelled runs pile up in Failing CI and the only thing the
// operator can do with one is press Dismiss. Most of them are the concurrency
// group doing its job -- a new push cancels the run still going for the previous
// commit -- and the rest were cancelled deliberately. Either way there is no
// retry worth queueing and no failure to read, so the server now flags them
// `autoDismissed` and the dashboard treats them exactly like a locally dismissed
// row: out of the list and the Failing CI tile, counted in the dismissed bar,
// revealed by "Show", and never written to localStorage.
//
// The rows here carry the shape the server produces (server.test.js pins the
// marking itself); this file pins what the dashboard does with it.
//
// Network is fully mocked, so no server and no GitHub are needed.

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "public/index.html"), "utf8");
const appJs = readFileSync(path.join(root, "public/app.js"), "utf8");
const themeJs = readFileSync(path.join(root, "public/theme.js"), "utf8");
const stylesCss = readFileSync(path.join(root, "public/styles.css"), "utf8");

function workflowRun(repo, runNumber, extra = {}) {
  return {
    kind: "workflowRun",
    repo,
    workflow: "CI",
    runNumber: `#${runNumber}`,
    title: `CI run ${runNumber} on ${repo}`,
    branch: "main",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-06-04T11:00:00Z",
    url: `https://github.com/${repo}/actions/runs/${runNumber}`,
    ...extra
  };
}

const cancelledRun = workflowRun("acme/alpha", 201, {
  title: "Superseded by a newer push",
  conclusion: "cancelled",
  autoDismissed: true,
  autoDismissReason: "Cancelled run — auto-dismissed, nothing to act on"
});
const failedRun = workflowRun("acme/bravo", 202);

function statusFixture(failedRuns) {
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: "2026-06-04T12:00:00Z",
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 2,
      passingPrs: 0, noCiPrs: 0, failingPrs: failedRuns.length, conflictPrs: 0, runningPrs: 0,
      runningCd: 0, finishedCd: 0, failedCd: 0, skippedCd: 0,
      runningDeployments: 0, busyRunners: 0,
      flaggedJourneys: 0, activeJourneys: 0, shippedJourneys: 0, tracingUnknown: 0
    },
    pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
    actions: { failed: failedRuns, running: [] },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

async function openDashboard(failedRuns) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.addInitScript(() => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "fail" }));
    localStorage.removeItem("pr-deck:dismissed:v1");
  });

  const body = JSON.stringify(statusFixture(failedRuns));
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/" || p === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (p === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (p === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
    if (p === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (p === "/api/status") return route.fulfill({ contentType: "application/json", body });
    if (p === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("#content");
  return { browser, page };
}

const readDismissedKeys = (page) =>
  page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("pr-deck:dismissed:v1") || "{}")));

test("a cancelled run leaves Failing CI without the operator touching it", { skip }, async () => {
  const { browser, page } = await openDashboard([cancelledRun, failedRun]);
  try {
    await page.waitForSelector("article.row");
    // The real failure is still there -- otherwise "the cancelled run is gone"
    // would also be true of a lane that simply rendered nothing.
    assert.equal(await page.locator("article.row").count(), 1, "only the real failure stays actionable");
    assert.match(await page.locator("article.row .title").innerText(), /CI run 202/);
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /1 dismissed item/);
    assert.equal(await page.locator("#metricFailing").innerText(), "1", "Failing CI tile drops the cancelled run");
    assert.match(await page.title(), /^\(1\)/, "tab title counts only the actionable failure");
    assert.deepEqual(await readDismissedKeys(page), [], "auto-dismissals never touch localStorage");
  } finally {
    await browser.close();
  }
});

test("Show reveals the cancelled run, labelled automatic and with no rerun to press", { skip }, async () => {
  const { browser, page } = await openDashboard([cancelledRun, failedRun]);
  try {
    await page.waitForSelector("[data-dismiss-toggle]");
    await page.click("[data-dismiss-toggle]");
    await page.waitForFunction(() => document.querySelectorAll("article.row").length === 2);

    const auto = page.locator("article.row", { hasText: "Superseded by a newer push" });
    assert.equal(await auto.locator(".row-dismiss-auto").innerText(), "Auto-dismissed");
    assert.equal(await auto.locator("[data-dismiss-key]").count(), 0, "no per-row dismiss control on an auto row");
    assert.match(await auto.locator(".tag").first().innerText(), /cancelled/i, "the run still reads as cancelled");
    assert.equal(await auto.locator(".open-link").count(), 1, "the run stays one click from GitHub");
    assert.match(
      await auto.locator(".row-dismiss-auto").getAttribute("title"),
      /[Cc]ancelled/,
      "the row says why it was dismissed rather than just that it was"
    );
  } finally {
    await browser.close();
  }
});

test("Restore all does not drag cancelled runs back into the list", { skip }, async () => {
  // The user's own dismissals and the server's must not share a lever: pressing
  // Restore all to undo a mistaken Dismiss should not also re-fill the lane with
  // the cancelled noise the server took out.
  const { browser, page } = await openDashboard([cancelledRun, failedRun, workflowRun("acme/charlie", 203)]);
  try {
    await page.waitForSelector("[data-dismiss-all]");
    await page.click("[data-dismiss-all]");
    await page.waitForSelector("[data-restore-all]");

    assert.equal(await page.locator("article.row").count(), 0, "everything hidden after Dismiss all");
    assert.equal(
      (await readDismissedKeys(page)).length,
      2,
      "Dismiss all persists only the two user-dismissable runs"
    );

    await page.click("[data-restore-all]");
    await page.waitForFunction(() => document.querySelectorAll("article.row").length === 2);
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /1 dismissed item/);
    assert.deepEqual(await readDismissedKeys(page), [], "restore clears every user dismissal");
  } finally {
    await browser.close();
  }
});
