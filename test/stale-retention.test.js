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
const themeJsPath = path.join(root, "public/theme.js");
const themeJs = existsSync(themeJsPath) ? readFileSync(themeJsPath, "utf8") : null;

const QUOTA_ERROR = "API rate limit exceeded for user ID 6900106.";

function status(overrides = {}) {
  return {
    account: "cached-account",
    accounts: ["cached-account"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 85,
      passingPrs: 3,
      noCiPrs: 1,
      failingPrs: 2,
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

// The shape server.js sends once the core bucket is spent: an error plus the
// live rate-limit figures, and none of the dashboard payload.
function exhaustedResponse() {
  return {
    error: QUOTA_ERROR,
    rateLimit: {
      tightest: {
        resource: "core",
        remaining: 0,
        limit: 5000,
        resetAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      },
      buckets: []
    }
  };
}

// A failure with nothing to say about quota -- the server being down, or any
// error that is not the rate limiter.
function outageResponse() {
  return { error: "Unable to refresh dashboard" };
}

async function openPage(browser) {
  const page = await browser.newPage();
  let respond = { ok: true, body: status() };

  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      return route.fulfill({ contentType: "text/html", body: indexHtml });
    }
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/theme.js" && themeJs !== null) {
      return route.fulfill({ contentType: "text/javascript", body: themeJs });
    }
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/api/status") {
      return route.fulfill({
        status: respond.ok ? 200 : (respond.status || 429),
        contentType: "application/json",
        body: JSON.stringify(respond.body)
      });
    }
    if (pathname === "/favicon.svg") {
      return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  return { page, setResponse: (next) => { respond = next; } };
}

async function deckState(page) {
  return page.evaluate(() => ({
    repos: document.querySelector("#metricRepos").textContent,
    failing: document.querySelector("#metricFailing").textContent,
    generatedAt: document.querySelector("#generatedAt").textContent,
    noticeHidden: document.querySelector("#refreshPauseNotice").classList.contains("hidden"),
    noticeReason: document.querySelector("#refreshPauseNotice").dataset.reason || "",
    noticeTitle: document.querySelector("#refreshPauseTitle").textContent,
    noticeDetail: document.querySelector("#refreshPauseDetail").textContent,
    error: document.querySelector("#errorPanel").textContent,
    errorHidden: document.querySelector("#errorPanel").classList.contains("hidden")
  }));
}

test("a reload during a quota block shows the last data pulled, not an empty deck", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, setResponse } = await openPage(browser);

    // First visit succeeds, which is what fills the cache.
    await page.goto("http://localhost/");
    await page.waitForFunction(() => document.querySelector("#metricRepos")?.textContent === "85");

    // Reload while GitHub is refusing every request.
    setResponse({ ok: false, body: exhaustedResponse() });
    await page.reload();
    await page.locator("#refreshPauseNotice").waitFor({ state: "visible" });

    const deck = await deckState(page);
    assert.equal(deck.repos, "85", "the stored payload is drawn instead of zeros");
    assert.equal(deck.failing, "2");
    assert.notEqual(deck.generatedAt, "never", "the deck reports when its data was pulled");
    // Quota is the more specific cause, so that notice wins over the generic
    // stale one -- and it already carries its own "Data may be stale" badge.
    assert.equal(deck.noticeReason, "quota");
    assert.match(deck.noticeDetail, /quota is too low \(0\/5000\)/);
    // The live failure is still stated verbatim rather than hidden behind the deck.
    assert.equal(deck.errorHidden, false);
    assert.match(deck.error, /API rate limit exceeded for user ID 6900106/);
  } finally {
    await browser.close();
  }
});

test("the quota readout describes now, not when the cache was written", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, setResponse } = await openPage(browser);
    await page.goto("http://localhost/");
    await page.waitForFunction(() => document.querySelector("#metricRepos")?.textContent === "85");

    setResponse({ ok: false, body: exhaustedResponse() });
    await page.reload();
    await page.locator("#refreshPauseNotice").waitFor({ state: "visible" });

    // The cache holds 5000/5000; the failed response carries the real 0/5000.
    const rateLimit = await page.locator("#rateLimit").textContent();
    assert.match(rateLimit, /core: 0\/5000/, `expected the live figures, got: ${rateLimit}`);
  } finally {
    await browser.close();
  }
});

test("a first-ever visit that fails still reports the failure and claims nothing", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, setResponse } = await openPage(browser);
    setResponse({ ok: false, body: exhaustedResponse() });

    await page.goto("http://localhost/");
    await page.locator("#errorPanel").waitFor({ state: "visible" });

    const deck = await deckState(page);
    assert.equal(deck.repos, "0", "nothing is invented when there is no cache");
    assert.equal(deck.generatedAt, "never");
    // No stale notice, because there is no stale data behind it.
    assert.notEqual(deck.noticeReason, "stale");
    assert.match(deck.error, /API rate limit exceeded/);
  } finally {
    await browser.close();
  }
});

test("a failure mid-session leaves the deck that is already on screen", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, setResponse } = await openPage(browser);
    await page.goto("http://localhost/");
    await page.waitForFunction(() => document.querySelector("#metricRepos")?.textContent === "85");

    setResponse({ ok: false, body: exhaustedResponse() });
    await page.keyboard.press("r");
    await page.locator("#errorPanel").waitFor({ state: "visible" });

    const deck = await deckState(page);
    assert.equal(deck.repos, "85");
    assert.equal(deck.failing, "2");
    // Held in memory, so this is not the cold-start fallback and must not say so.
    assert.notEqual(deck.noticeReason, "stale");
  } finally {
    await browser.close();
  }
});

test("a cached payload past its day is not resurrected", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, setResponse } = await openPage(browser);
    await page.goto("http://localhost/");
    await page.waitForFunction(() => document.querySelector("#metricRepos")?.textContent === "85");

    // Backdate the cache past the 24h ceiling.
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("pr-deck:status:v1"));
      raw.savedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      localStorage.setItem("pr-deck:status:v1", JSON.stringify(raw));
    });

    setResponse({ ok: false, body: exhaustedResponse() });
    await page.reload();
    await page.locator("#errorPanel").waitFor({ state: "visible" });

    const deck = await deckState(page);
    assert.equal(deck.repos, "0", "day-old data is not presented as the current picture");
    assert.notEqual(deck.noticeReason, "stale");
  } finally {
    await browser.close();
  }
});

test("a reload during an outage names the age of what it is showing", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, setResponse } = await openPage(browser);
    await page.goto("http://localhost/");
    await page.waitForFunction(() => document.querySelector("#metricRepos")?.textContent === "85");

    // No rateLimit in the response, so nothing points at quota as the cause.
    setResponse({ ok: false, status: 500, body: outageResponse() });
    await page.reload();
    await page.locator("#refreshPauseNotice").waitFor({ state: "visible" });

    const deck = await deckState(page);
    assert.equal(deck.repos, "85", "the stored payload is drawn instead of zeros");
    assert.equal(deck.noticeReason, "stale");
    assert.equal(deck.noticeTitle, "Showing the last data pulled");
    assert.match(deck.noticeDetail, /are not being updated/);
    assert.match(deck.error, /Unable to refresh dashboard/);
  } finally {
    await browser.close();
  }
});
