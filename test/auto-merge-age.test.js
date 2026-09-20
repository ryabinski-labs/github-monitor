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
const HOUR_MS = 60 * 60 * 1000;
const PR_URL = "https://github.com/acme/app/pull/7";

function pullRequest() {
  return {
    repo: "acme/app",
    number: 7,
    numberLabel: "#7",
    title: "Ready to merge",
    author: "octocat",
    url: PR_URL,
    state: "pass",
    checkCount: 2,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    hasConflict: false,
    isDraft: false
  };
}

function statusFixture(candidate = false) {
  const candidates = candidate
    ? [{
        repo: "acme/app",
        number: 7,
        deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      }]
    : [];
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    autoMerge: { enabled: true, candidates },
    summary: {
      repos: 1,
      passingPrs: 1,
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
      busyRunners: 0,
      flaggedJourneys: 0,
      activeJourneys: 0,
      shippedJourneys: 0,
      tracingUnknown: 0
    },
    pullRequests: { pass: [pullRequest()], noCi: [], fail: [], running: [], conflicts: [], behind: [] },
    actions: { failed: [], running: [] },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

async function openAtAutoMergeAge(ageMs) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  let candidate = false;
  const now = Date.now();

  // Freeze the browser clock so the exact one-hour boundary cannot drift a few
  // milliseconds past the threshold while the fixture and page are loading.
  await page.clock.setFixedTime(now);

  await page.addInitScript(({ enteredAt, url }) => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "pass", autoMerge: true, notifications: false }));
    localStorage.setItem("pr-deck:phase-ages:v1", JSON.stringify({
      [`auto_merge_waiting:${url}`]: {
        phase: "auto_merge_waiting",
        enteredAt,
        observedAt: new Date().toISOString()
      }
    }));
  }, { enteredAt: new Date(now - ageMs).toISOString(), url: PR_URL });

  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      return route.fulfill({ contentType: "text/html", body: indexHtml });
    }
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/api/auto-merge") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(statusFixture(candidate).autoMerge)
      });
    }
    if (pathname === "/api/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture(candidate)) });
    }
    if (pathname === "/favicon.svg") {
      return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    }
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("article.row");
  candidate = true;
  await page.click("#refresh");
  await page.waitForFunction(() => {
    const pill = document.querySelector("article.row .phase-pill");
    return pill?.textContent?.includes("Auto merge");
  });
  return { browser, page };
}

test("auto merge stays unflagged and silent before one hour", { skip }, async () => {
  const { browser, page } = await openAtAutoMergeAge(HOUR_MS - 5 * 60 * 1000);
  try {
    assert.equal(await page.locator("article.row").getAttribute("class"), "row");
    assert.match(await page.locator(".phase-pill").innerText(), /^Auto merge 55m/);
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]")),
      []
    );
  } finally {
    await browser.close();
  }
});

test("auto merge stays unflagged and silent at exactly one hour", { skip }, async () => {
  const { browser, page } = await openAtAutoMergeAge(HOUR_MS);
  try {
    assert.equal(await page.locator("article.row").getAttribute("class"), "row");
    assert.equal(await page.locator(".phase-pill").innerText(), "Auto merge 1h 0m");
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]")),
      []
    );
  } finally {
    await browser.close();
  }
});

test("auto merge is flagged and notified after one hour", { skip }, async () => {
  const { browser, page } = await openAtAutoMergeAge(HOUR_MS + 5 * 60 * 1000);
  try {
    assert.match(await page.locator("article.row").getAttribute("class"), /row-stale/);
    assert.match(await page.locator(".phase-pill").innerText(), /^Stale Auto merge 1h 5m/);
    const inbox = await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]"));
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].title, "Pipeline flagged");
    assert.match(inbox[0].body, /expected under 1h/);

    await page.click("#refresh");
    await page.waitForTimeout(100);
    const afterRefresh = await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]"));
    assert.equal(afterRefresh.length, 1, "the same overdue auto merge is notified only once");
  } finally {
    await browser.close();
  }
});
