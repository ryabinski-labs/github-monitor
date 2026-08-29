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

// Runner rows carry no url/repo/workflow/runNumber, so they used to share the
// single phase key "runner_busy:" and report one clock for the whole fleet --
// the dashboard's own uptime, persisted across reloads. Two runners with
// different job start times are what makes that regression visible.
function busyRunner(name, startedAgoMs) {
  return {
    level: "ORG",
    scope: "acme",
    name,
    status: "online",
    labels: ["self-hosted", "Linux", "X64"],
    ...(startedAgoMs === null
      ? {}
      : { startedAt: new Date(Date.now() - startedAgoMs).toISOString() })
  };
}

function statusFixture(busy) {
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
      runningActions: 0,
      runningCd: 0,
      finishedCd: 0,
      failedCd: 0,
      skippedCd: 0,
      runningDeployments: 0,
      busyRunners: busy.length,
      flaggedJourneys: 0,
      activeJourneys: 0,
      shippedJourneys: 0,
      tracingUnknown: 0
    },
    pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
    actions: { failed: [], running: [] },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

async function renderRunners(busy) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const status = statusFixture(busy);

  await page.addInitScript(() => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "runners" }));
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

  await page.goto("http://localhost/");
  await page.waitForSelector("article.row");
  return { browser, page };
}

test("each busy runner ages on its own job's start, not a shared clock", { skip }, async () => {
  const { browser, page } = await renderRunners([
    busyRunner("runner-fresh", 12 * 60 * 1000),
    busyRunner("runner-long", 3 * HOUR_MS)
  ]);

  try {
    const rows = page.locator("article.row");
    assert.equal(await rows.count(), 2);

    const fresh = rows.filter({ hasText: "runner-fresh" }).locator(".phase-pill");
    const long = rows.filter({ hasText: "runner-long" }).locator(".phase-pill");

    // Distinct ages prove the two rows no longer share one phase entry.
    assert.match(await fresh.innerText(), /^Runner busy 12m/);
    assert.match(await long.innerText(), /^Stale Runner busy 3h/);

    // The 2h threshold must apply per runner, so the fresh one stays unflagged.
    assert.equal(await rows.filter({ hasText: "runner-fresh" }).getAttribute("class"), "row");
    assert.match(await rows.filter({ hasText: "runner-long" }).getAttribute("class"), /row-stale/);
  } finally {
    await browser.close();
  }
});

test("a runner with no correlated job falls back to first observation", { skip }, async () => {
  const { browser, page } = await renderRunners([busyRunner("runner-unknown", null)]);

  try {
    const pill = page.locator("article.row").filter({ hasText: "runner-unknown" }).locator(".phase-pill");
    // No startedAt means the age starts now -- not at whenever the dashboard
    // first saw any runner, which is what the shared key used to produce.
    assert.match(await pill.innerText(), /^Runner busy 0s/);
    assert.equal(await page.locator("article.row").getAttribute("class"), "row");
  } finally {
    await browser.close();
  }
});
