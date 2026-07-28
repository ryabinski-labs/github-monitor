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
const HOUR_MS = 60 * 60 * 1000;

function runningWorkflow(runNumber, ageMs) {
  return {
    kind: "workflowRun",
    repo: "acme/app",
    workflow: "CI",
    runNumber,
    title: `CI run ${runNumber}`,
    branch: "main",
    status: "in_progress",
    conclusion: null,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    url: `https://github.com/acme/app/actions/runs/${runNumber}`
  };
}

function statusFixture() {
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 1,
      passingPrs: 0,
      noCiPrs: 0,
      failingPrs: 0,
      conflictPrs: 0,
      runningPrs: 0,
      runningActions: 2,
      runningCd: 0,
      finishedCd: 0,
      failedCd: 0,
      skippedCd: 0,
      runningDeployments: 0,
      busyRunners: 0,
      flaggedJourneys: 0,
      activeJourneys: 0,
      shippedJourneys: 0,
      tracingUnknown: 0
    },
    pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
    actions: {
      failed: [],
      running: [
        runningWorkflow(101, 4 * HOUR_MS - 5 * 60 * 1000),
        runningWorkflow(102, 4 * HOUR_MS + 5 * 60 * 1000)
      ]
    },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

test("workflow rows become stale only after four hours", { skip }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const status = statusFixture();

  await page.addInitScript(() => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "running" }));
  });
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      return route.fulfill({ contentType: "text/html", body: indexHtml });
    }
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/api/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(status) });
    }
    if (pathname === "/favicon.svg") {
      return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    }
    return route.fulfill({ status: 204, body: "" });
  });

  try {
    await page.goto("http://localhost/");
    await page.waitForSelector("article.row");

    const rows = page.locator("article.row");
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.filter({ hasText: "CI run 101" }).getAttribute("class"), "row");
    assert.match(await rows.filter({ hasText: "CI run 102" }).getAttribute("class"), /row-stale/);
    assert.match(await rows.filter({ hasText: "CI run 101" }).locator(".phase-pill").innerText(), /^Workflow running 3h 55m/);
    assert.match(await rows.filter({ hasText: "CI run 102" }).locator(".phase-pill").innerText(), /^Stale Workflow running 4h 5m/);
  } finally {
    await browser.close();
  }
});
