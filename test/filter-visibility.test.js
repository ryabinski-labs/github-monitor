// Regression coverage for the "filtered view" treatment.
//
// A search filter re-scopes every count on the dashboard -- tiles, rail, trace
// pills. Unmarked, that reads exactly like a quiet org: "CI Running 1 /
// Runners 0" is indistinguishable from the real thing, which is how a filtered
// screenshot once got mistaken for a scan that had missed most of the org.
//
// Covers:
//   1. Nothing is marked while the filter is empty -- no banner, no dashed
//      tiles, no "of N" badges, and the counts read as plain numbers.
//   2. Typing a filter raises the banner, outlines the scoreboard, and puts the
//      true unfiltered total beside every count the filter changed.
//   3. A count the filter did not change gets no badge (no false alarm).
//   4. Every exit -- the banner button, the input's x, and Escape from
//      anywhere on the page -- clears the filter and every mark with it.
//   5. Escape that dismisses something else (the owner picker) leaves the
//      filter alone -- one keypress, one dismissal.
//   6. A query with no break opportunities does not stretch the page.
//   7. The rail's counts stay in one column whatever width the badges are.

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

function workflowRun(repo, runNumber, branch) {
  return {
    kind: "workflowRun",
    repo,
    workflow: "CI",
    runNumber,
    title: `CI run ${runNumber} on ${repo}`,
    branch,
    status: "in_progress",
    conclusion: null,
    createdAt: "2026-09-06T10:30:00Z",
    url: `https://github.com/${repo}/actions/runs/${runNumber}`
  };
}

function busyRunner(name) {
  return { name, status: "online", busy: true, os: "linux", labels: ["self-hosted"], url: "https://github.com" };
}

// Three running workflow runs, exactly one of which matches "harn"; six busy
// runners, none of which match. This is the shape that produced the original
// misread: CI Running collapses 3 -> 1 and Runners collapses 6 -> 0.
const statusFixture = {
  account: "acme",
  accounts: ["acme"],
  generatedAt: "2026-09-06T12:00:00Z",
  warnings: [],
  options: {},
  autoMerge: { enabled: false, items: [] },
  scan: { reposConsidered: 10, reposScanned: 10, reposSkipped: 0, pushedWithinHours: 168, repoFloor: 10 },
  summary: {
    repos: 10,
    passingPrs: 0, noCiPrs: 0, failingPrs: 0, conflictPrs: 0, runningPrs: 3,
    // finishedCd is deliberately four digits: its "of 1420" badge is the widest
    // in the rail, which is what made the counts jitter before the fix.
    runningCd: 0, finishedCd: 1420, failedCd: 0, skippedCd: 0,
    runningDeployments: 0, busyRunners: 6,
    flaggedJourneys: 0, activeJourneys: 0, shippedJourneys: 0, tracingUnknown: 0
  },
  pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
  actions: {
    failed: [],
    running: [
      workflowRun("acme/waf", 149, "harness/de2cb7aa/main"),
      workflowRun("acme/alpha", 20, "main"),
      workflowRun("acme/bravo", 21, "main")
    ]
  },
  cd: { running: [], finished: [], failed: [] },
  deployments: { running: [] },
  runners: {
    busy: [
      busyRunner("pc-actions-runner"),
      busyRunner("github-runner-i-0b98de267319d0ba2"),
      busyRunner("github-runner-emulator-i-04759b0794436a7c7"),
      busyRunner("github-runner-emulator-i-04a18526efbc58a94"),
      busyRunner("github-runner-i-04db06b55836fcad4"),
      busyRunner("github-runner-i-06e12a67a5ef4cd6e")
    ]
  },
  traces: { flagged: [], active: [], completed: [], unknown: [] },
  refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
  rateLimit: { core: { remaining: 5000, limit: 5000 } }
};

async function openDashboard() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.addInitScript(() => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "running", traceFilter: "flagged" }));
    localStorage.removeItem("pr-deck:dismissed:v1");
    localStorage.removeItem("pr-deck:traces:v1");
  });

  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/" || p === "/index.html") return route.fulfill({ contentType: "text/html", body: asset("index.html") });
    if (p === "/app.js") return route.fulfill({ contentType: "text/javascript", body: asset("app.js") });
    if (p === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: asset("theme.js") });
    if (p === "/styles.css") return route.fulfill({ contentType: "text/css", body: asset("styles.css") });
    if (p === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture) });
    if (p === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector(".row");
  return { browser, page };
}

const noticeVisible = (page) => page.locator("#filterNotice").isVisible();

test("an unfiltered dashboard carries no filtered-view marks", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    assert.equal(await noticeVisible(page), false, "no banner without a filter");
    assert.equal(await page.locator("#scoreboard.is-filtered").count(), 0);
    assert.equal(await page.locator("#rail.is-filtered").count(), 0);
    assert.equal(await page.locator("#filterBox.is-active").count(), 0);
    assert.equal(await page.locator(".metric-total, .rail-total").count(), 0, "no true-total badges");
    assert.equal(await page.locator("#filterCount").innerText(), "");

    assert.equal(await page.locator("#metricRunning").innerText(), "3");
    assert.equal(await page.locator("#navRunners").innerText(), "6");
    assert.equal(await page.locator("#scoreboard").getAttribute("aria-label"), "Summary");
  } finally {
    await browser.close();
  }
});

test("a filter raises the banner and keeps the true total beside every changed count", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    await page.fill("#filter", "harn");
    await page.waitForSelector("#filterNotice:not([hidden])");

    // The banner names the query and says the counts are not totals.
    const notice = await page.locator("#filterNotice").innerText();
    assert.match(notice, /FILTERED VIEW/i);
    assert.match(notice, /Showing 1 of 3 rows matching/);
    assert.match(notice, /harn/);
    assert.match(notice, /not totals/);

    // Scoreboard, rail and input all carry the mode.
    assert.equal(await page.locator("#scoreboard.is-filtered").count(), 1);
    assert.equal(await page.locator("#rail.is-filtered").count(), 1);
    assert.equal(await page.locator("#filterBox.is-active").count(), 1);
    assert.match(await page.locator("#scoreboard").getAttribute("aria-label"), /filtered by/i);
    assert.match(await page.locator("#rail").getAttribute("aria-label"), /filtered by/i);
    assert.equal(await page.locator("#filterCount").innerText(), "1 of 3");

    // The <strong> still holds what is shown; the honest total sits next to it.
    assert.equal(await page.locator("#metricRunning").innerText(), "1");
    assert.equal(await page.locator("#metricRunning + .metric-total").innerText(), "of 3");

    // Runners collapsing to zero is the exact trap -- the 6 must stay on screen.
    assert.equal(await page.locator("#navRunners").innerText(), "0");
    assert.equal(await page.locator("#navRunners + .rail-total").innerText(), "of 6");

    // A tile the filter did not change raises no false alarm.
    assert.equal(await page.locator("#metricPassing").innerText(), "0");
    assert.equal(await page.locator("#metricPassing ~ .metric-total").count(), 0);

    // The dashed outline is really applied, not just a class name.
    const borderStyle = await page.locator("#metricRunning").evaluate(
      (el) => getComputedStyle(el.closest(".metric")).borderStyle
    );
    assert.equal(borderStyle, "dashed");
  } finally {
    await browser.close();
  }
});

test("Escape that closes the owner picker leaves the filter alone", { skip }, async () => {
  // The owner-picker listener is registered before the shortcuts handler, so it
  // clears state.ownerPickerOpen first; without an explicit hand-off the same
  // keypress would fall through and wipe the filter too.
  const { browser, page } = await openDashboard();
  try {
    await page.fill("#filter", "harn");
    await page.waitForSelector("#filterNotice:not([hidden])");

    await page.click("#ownerPickerToggle");
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert.equal(await page.inputValue("#filter"), "harn", "closing the picker must not clear the filter");
    assert.equal(await page.locator("#filterNotice").isVisible(), true);

    // The next Escape, with nothing else open, does clear it.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#filterNotice", { state: "hidden" });
    assert.equal(await page.inputValue("#filter"), "");
  } finally {
    await browser.close();
  }
});

test("a query with no break opportunities does not stretch the page", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    await page.fill("#filter", "q".repeat(600));
    await page.waitForSelector("#filterNotice:not([hidden])");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    assert.equal(overflows, false, "a 600-character filter must not scroll the page sideways");

    // The banner echoes a trimmed query rather than all 600 characters.
    const detail = await page.locator("#filterNoticeDetail").innerText();
    assert.ok(detail.includes("\u2026"), "long queries are elided in the banner");
    assert.ok(detail.length < 300, `banner text stayed short (${detail.length} chars)`);

    // The empty state echoes the query too, and must trim it the same way.
    const empty = await page.locator("#content .empty").innerText();
    assert.ok(empty.length < 300, `empty state stayed short (${empty.length} chars)`);
  } finally {
    await browser.close();
  }
});

test("rail counts stay in one column whatever width the true totals are", { skip }, async () => {
  // Each .rail-item is its own grid, so an "of 1420" badge would push its count
  // left while an "of 6" badge would not, leaving the numbers ragged.
  const { browser, page } = await openDashboard();
  try {
    await page.fill("#filter", "harn");
    await page.waitForSelector("#filterNotice:not([hidden])");

    const edges = await page.evaluate(() =>
      [...document.querySelectorAll(".rail-item")]
        .filter((el) => el.querySelector(".rail-total"))
        .map((el) => Math.round(el.querySelector("strong").getBoundingClientRect().right))
    );
    assert.ok(edges.length >= 2, "several rail counts carry a true total");
    assert.equal(new Set(edges).size, 1, `counts share one right edge, got ${JSON.stringify(edges)}`);
  } finally {
    await browser.close();
  }
});

test("every exit clears the filter and all of its marks", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    for (const exit of [
      async () => page.click("#filterNoticeClear"),
      async () => page.click("#filterClear"),
      // Escape from the page body, not just from inside the input.
      async () => { await page.locator("h2#viewTitle").click(); await page.keyboard.press("Escape"); }
    ]) {
      await page.fill("#filter", "harn");
      await page.waitForSelector("#filterNotice:not([hidden])");
      await exit();
      await page.waitForSelector("#filterNotice", { state: "hidden" });

      assert.equal(await page.inputValue("#filter"), "");
      assert.equal(await page.locator(".metric-total, .rail-total").count(), 0);
      assert.equal(await page.locator("#scoreboard.is-filtered").count(), 0);
      assert.equal(await page.locator("#metricRunning").innerText(), "3");
      assert.equal(await page.locator("#navRunners").innerText(), "6");
    }
  } finally {
    await browser.close();
  }
});
