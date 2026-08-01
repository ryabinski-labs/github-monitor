// Regression coverage for server-side auto-dismissal of failed Dependabot runs.
//
// Reported symptom: a failed `dependabot/dependabot-updates` run sat in Failing
// CI forever. It has no pull request to close and it is already completed, so
// neither half of the Dependabot cleanup policy can ever resolve it. With
// cleanup enabled the server now flags those rows `autoDismissed`, and the
// dashboard must treat them exactly like a locally dismissed row — hidden from
// the list and the Failing CI tile, counted in the dismissed bar, revealed by
// "Show" — while never writing them to localStorage, so the user's own
// dismissals stay the only thing "Restore all" touches.
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

const dependabotRun = workflowRun("acme/alpha", 101, {
  workflow: "npm_and_yarn in /frontend for brace-expansion - Update #1499055677",
  title: "npm_and_yarn in /frontend for brace-expansion - Update #1499055677",
  dependabot: true,
  autoDismissed: true,
  autoDismissReason: "Dependabot run — auto-dismissed by cleanup"
});
const humanRun = workflowRun("acme/bravo", 102);

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

test("a failed Dependabot run is hidden, counted as dismissed, and reviewable", { skip }, async () => {
  const { browser, page } = await openDashboard([dependabotRun, humanRun]);
  try {
    await page.waitForSelector("article.row");
    assert.equal(await page.locator("article.row").count(), 1, "only the human run stays actionable");
    assert.match(await page.locator("article.row .title").innerText(), /CI run 102/);
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /1 dismissed item/);
    assert.equal(await page.locator("#metricFailing").innerText(), "1", "Failing CI tile drops the Dependabot run");
    assert.match(await page.title(), /^\(1\)/, "tab title counts only the actionable failure");
    assert.deepEqual(await readDismissedKeys(page), [], "auto-dismissals never touch localStorage");

    // "Show" reveals it, labelled as automatic rather than offering a button.
    await page.click("[data-dismiss-toggle]");
    await page.waitForFunction(() => document.querySelectorAll("article.row").length === 2);
    const auto = page.locator("article.row", { hasText: "brace-expansion" });
    assert.equal(await auto.locator(".row-dismiss-auto").innerText(), "Auto-dismissed");
    assert.equal(await auto.locator("[data-dismiss-key]").count(), 0, "no per-row dismiss control on an auto row");
  } finally {
    await browser.close();
  }
});

test("bulk restore leaves auto-dismissed Dependabot runs alone", { skip }, async () => {
  const { browser, page } = await openDashboard([dependabotRun, humanRun, workflowRun("acme/charlie", 103)]);
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
    assert.equal(await page.locator("article.row").count(), 2, "the Dependabot run stays dismissed after Restore all");
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /1 dismissed item/);
    assert.deepEqual(await readDismissedKeys(page), [], "restore clears every user dismissal");
  } finally {
    await browser.close();
  }
});
