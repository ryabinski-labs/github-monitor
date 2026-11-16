// The close button must never send a reasonless close. The API rejects one,
// but the dashboard should ask first and send what the operator typed so the
// PR comment and the request agree.

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
const skip = browserMissing ? "Playwright Chromium not installed — run: npx playwright install chromium" : false;

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const asset = (name) => readFileSync(path.join(publicDir, name), "utf8");
const PR_URL = "https://github.com/acme/app/pull/7";

function statusFixture() {
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    autoMerge: { enabled: false, candidates: [] },
    summary: {
      repos: 1, passingPrs: 1, noCiPrs: 0, failingPrs: 0, conflictPrs: 0, runningPrs: 0,
      runningActions: 0, runningCd: 0, finishedCd: 0, failedCd: 0, skippedCd: 0,
      runningDeployments: 0, busyRunners: 0, flaggedJourneys: 0, activeJourneys: 0,
      shippedJourneys: 0, tracingUnknown: 0
    },
    pullRequests: {
      pass: [{
        repo: "acme/app", number: 7, numberLabel: "#7", title: "Ready to merge",
        author: "octocat", url: PR_URL, state: "pass", checkCount: 2,
        mergeable: "MERGEABLE", baseRefName: "main", hasConflict: false, isDraft: false
      }],
      noCi: [], fail: [], running: [], conflicts: [], behind: []
    },
    actions: { failed: [], running: [] },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

test("the close button asks for a reason and sends it", { skip }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const closeBodies = [];
  await page.addInitScript(() => {
    window.__closeReason = "";
    window.prompt = () => window.__closeReason;
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "pass", autoMerge: false, notifications: false }));
  });
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: asset("index.html") });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: asset("app.js") });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: asset("theme.js") });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: asset("styles.css") });
    if (pathname === "/api/auto-merge") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture().autoMerge) });
    }
    if (pathname === "/api/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture()) });
    }
    if (pathname === "/api/pull-request/close") {
      closeBodies.push(JSON.parse(route.request().postData() || "{}"));
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          closed: true,
          pr: { repo: "acme/app", number: 7, numberLabel: "#7", title: "Ready to merge", url: PR_URL }
        })
      });
    }
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    return route.fulfill({ status: 204, body: "" });
  });

  try {
    await page.goto("http://localhost/");
    await page.waitForSelector("article.row .close-button");

    // Blank reason: the click is cancelled before any request leaves the page.
    await page.evaluate(() => { window.__closeReason = "   "; });
    await page.locator(".close-button").click();
    await page.waitForTimeout(150);
    assert.deepEqual(closeBodies, [], "a blank reason must not close the PR");

    // A real reason is passed through unchanged after trimming.
    await page.evaluate(() => { window.__closeReason = "  housekeeping  "; });
    const requestPromise = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/api/pull-request/close"
    );
    await page.locator(".close-button").click();
    const request = await requestPromise;
    assert.deepEqual(JSON.parse(request.postData()), {
      repo: "acme/app",
      number: 7,
      reason: "housekeeping"
    });
    await page.waitForTimeout(150);
    assert.equal(closeBodies.length, 1);
  } finally {
    await browser.close();
  }
});
