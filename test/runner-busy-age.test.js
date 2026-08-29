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
function busyRunner(name, startedAgoMs, job = {}) {
  return {
    level: "ORG",
    scope: "acme",
    name,
    status: "online",
    labels: ["self-hosted", "Linux", "X64"],
    ...(startedAgoMs === null
      ? {}
      : { startedAt: new Date(Date.now() - startedAgoMs).toISOString() }),
    ...job
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
  let status = statusFixture(busy);

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

  // Serve a new fleet state and drive the dashboard's own refresh button, so the
  // second render goes through the same annotate/remember path a live poll uses.
  async function refreshWith(nextBusy) {
    status = statusFixture(nextBusy);
    await page.click("#refresh");
    await page.waitForFunction(
      (count) => document.querySelectorAll("article.row").length === count,
      nextBusy.length
    );
    await page.waitForTimeout(150);
  }

  return { browser, page, refreshWith };
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
    // first saw any runner, which is what the shared key used to produce. Assert
    // the unit rather than an exact second: a render slow enough to tick over to
    // 1s is not a regression, and pinning the digit made this test flaky.
    assert.match(await pill.innerText(), /^Runner busy \d{1,2}s\b/);
    assert.equal(await page.locator("article.row").getAttribute("class"), "row");
  } finally {
    await browser.close();
  }
});

// A runner that finishes one job and immediately picks up the next never leaves
// the "runner_busy" phase, and its phase key is its own identity, so the entry
// rememberPhase stored for the first job is still there for the second. Before
// this test, that entry won: the server sent the new job's started_at every
// refresh and the client discarded it, so a runner one minute into a fresh job
// still reported the previous job's age and stayed flagged stale.
test("a runner that moves to a new job ages from the new job's start", { skip }, async () => {
  const { browser, page, refreshWith } = await renderRunners([
    busyRunner("runner-1", 3 * HOUR_MS)
  ]);

  try {
    const pill = page.locator("article.row").filter({ hasText: "runner-1" }).locator(".phase-pill");
    assert.match(await pill.innerText(), /^Stale Runner busy 3h/);

    await refreshWith([busyRunner("runner-1", 60 * 1000)]);

    assert.match(await pill.innerText(), /^Runner busy 1m/);
    assert.equal(await page.locator("article.row").getAttribute("class"), "row");
  } finally {
    await browser.close();
  }
});

// The other half of the same rule: with no correlated job the row carries no
// startedAt, and first observation is all there is. That must not be re-pegged to
// "now" on every refresh, or a runner busy for hours would sit at 0s forever.
test("a runner with no correlated job keeps ageing from first observation", { skip }, async () => {
  const { browser, page, refreshWith } = await renderRunners([busyRunner("runner-unknown", null)]);

  try {
    const pill = page.locator("article.row").filter({ hasText: "runner-unknown" }).locator(".phase-pill");
    const first = await page.evaluate(() => {
      const ages = JSON.parse(localStorage.getItem("pr-deck:phase-ages:v1") || "{}");
      return ages["runner_busy:ORG:acme:runner-unknown"]?.enteredAt || "";
    });
    assert.notEqual(first, "");

    await refreshWith([busyRunner("runner-unknown", null)]);

    const second = await page.evaluate(() => {
      const ages = JSON.parse(localStorage.getItem("pr-deck:phase-ages:v1") || "{}");
      return ages["runner_busy:ORG:acme:runner-unknown"]?.enteredAt || "";
    });
    assert.equal(second, first, "first observation must survive a refresh");
    assert.match(await pill.innerText(), /^Runner busy /);
  } finally {
    await browser.close();
  }
});

// The same correlation that supplies the busy time also names the job holding the
// runner, so the row reports what it is working on and opens it. Without a
// correlated job there is no link, and the row must not become a dead click.
test("a correlated job is named on the row and opens from it", { skip }, async () => {
  const { browser, page } = await renderRunners([
    busyRunner("runner-1", 12 * 60 * 1000, {
      jobName: "build",
      jobRepo: "acme/app",
      url: "https://github.com/acme/app/actions/runs/1/job/11"
    }),
    busyRunner("runner-2", 5 * 60 * 1000)
  ]);

  try {
    const withJob = page.locator("article.row").filter({ hasText: "runner-1" });
    assert.match(await withJob.innerText(), /ORG · build · acme\/app/);
    assert.equal(
      await withJob.locator("a.open-link").getAttribute("href"),
      "https://github.com/acme/app/actions/runs/1/job/11"
    );
    assert.equal(
      await withJob.getAttribute("data-href"),
      "https://github.com/acme/app/actions/runs/1/job/11"
    );

    const noJob = page.locator("article.row").filter({ hasText: "runner-2" });
    assert.match(await noJob.innerText(), /ORG/);
    assert.equal(await noJob.locator("a.open-link").count(), 0);
    assert.equal(await noJob.getAttribute("data-href"), "");
  } finally {
    await browser.close();
  }
});
