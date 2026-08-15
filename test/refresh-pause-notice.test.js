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

function status(overrides = {}) {
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
    actions: { failed: [], running: [] },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: {
      tightest: {
        resource: "core",
        remaining: 5000,
        limit: 5000,
        resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      },
      buckets: []
    },
    ...overrides
  };
}

async function openDashboard(responseBody) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const statusRequests = [];
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      return route.fulfill({ contentType: "text/html", body: indexHtml });
    }
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/api/status") {
      statusRequests.push(route.request().url());
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(responseBody) });
    }
    if (pathname === "/favicon.svg") {
      return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForFunction(() => document.querySelector("#generatedAt")?.textContent !== "never");
  return { browser, page, statusRequests };
}

test("turning Auto off shows an obvious paused notice and keeps the R shortcut available", { skip }, async () => {
  const { browser, page, statusRequests } = await openDashboard(status());
  try {
    const notice = page.locator("#refreshPauseNotice");
    assert.equal(await notice.isHidden(), true);

    await page.locator("#autoRefresh").uncheck();

    await notice.waitFor({ state: "visible" });
    assert.equal(await page.locator("#refreshPauseTitle").textContent(), "Automatic pulling paused");
    assert.match(await page.locator("#refreshPauseDetail").innerText(), /only be pulled when you use Refresh/);
    assert.equal(await notice.getAttribute("role"), "status");
    assert.equal(await page.locator("#refresh").isEnabled(), true, "manual refresh remains available");

    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/status");
    await page.keyboard.press("r");
    await refreshed;
    assert.equal(statusRequests.length, 2, "R refreshes while the Auto checkbox retains focus");
  } finally {
    await browser.close();
  }
});

test("a quota block shows its cause and disables pulling", { skip }, async () => {
  const resetAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const blocked = status({
    refresh: {
      quota: { status: "low", blocked: true, resource: "core", remaining: 90, limit: 5000, resetAt },
      nextRefreshAt: resetAt,
      reason: "Paused for core API quota"
    },
    rateLimit: {
      tightest: { resource: "core", remaining: 90, limit: 5000, resetAt },
      buckets: []
    }
  });
  const { browser, page } = await openDashboard(blocked);
  try {
    const notice = page.locator("#refreshPauseNotice");
    await notice.waitFor({ state: "visible" });
    assert.equal(await page.locator("#refreshPauseTitle").textContent(), "Live updates paused");
    assert.match(await page.locator("#refreshPauseDetail").innerText(), /core API quota is too low \(90\/5000\)/);
    assert.match(await page.locator("#refreshPauseDetail").innerText(), /Pulling resumes automatically/);
    assert.equal(await notice.getAttribute("data-reason"), "quota");
    assert.equal(await page.locator("#refresh").isDisabled(), true);
    assert.equal(await page.locator("#refresh").getAttribute("aria-label"), "Refresh paused until GitHub API quota resets");

    await page.setViewportSize({ width: 320, height: 568 });
    await page.locator("#refreshPauseNotice").evaluate((element) => {
      for (const child of element.querySelectorAll("strong, .refresh-pause-copy > span, .refresh-pause-stale")) {
        child.style.fontSize = `${Number.parseFloat(getComputedStyle(child).fontSize) * 2}px`;
      }
    });
    const layout = await page.evaluate(() => {
      const topbar = document.querySelector(".topbar");
      const noticeBox = document.querySelector("#refreshPauseNotice").getBoundingClientRect();
      const staleBox = document.querySelector(".refresh-pause-stale").getBoundingClientRect();
      return {
        topbarPosition: getComputedStyle(topbar).position,
        noticeRight: noticeBox.right,
        staleRight: staleBox.right
      };
    });
    assert.equal(layout.topbarPosition, "static", "the enlarged mobile header can scroll out of view");
    assert.ok(layout.staleRight <= layout.noticeRight, "the stale-data badge wraps inside the notice");

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok(
      await page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().bottom <= 0),
      "the enlarged header does not cover the viewport after scrolling"
    );
  } finally {
    await browser.close();
  }
});
