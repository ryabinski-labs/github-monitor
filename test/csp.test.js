import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

import { SECURITY_HEADERS, server } from "../server.js";

let browserMissing = false;
try {
  browserMissing = !existsSync(chromium.executablePath());
} catch {
  browserMissing = true;
}
const skip = browserMissing
  ? "Playwright Chromium not installed — run: npx playwright install chromium"
  : false;

// The other browser tests stub every asset through page.route, which serves them
// with no headers at all -- so none of them can see a policy the real server
// sends. This one boots the actual server so index.html arrives under the real
// SECURITY_HEADERS, which is the only place an inline <script> gets refused.
function emptyStatus() {
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 0,
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
    rateLimit: { tightest: null, buckets: [] }
  };
}

// Every asset comes from the real server; only the GitHub-backed endpoint is
// stubbed, so nothing in the test reaches the network.
async function openAgainstServer({ storedSettings = null, blockAppJs = false } = {}) {
  const listener = await new Promise((resolve) => {
    const handle = server.listen(0, "127.0.0.1", () => resolve(handle));
  });
  const { port } = listener.address();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const violations = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI
      });
    });
  });
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });

  if (storedSettings) {
    await page.addInitScript((settings) => {
      localStorage.setItem("pr-deck:v1", JSON.stringify(settings));
    }, storedSettings);
  }

  await page.route("**/api/status*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(emptyStatus()) })
  );
  // Auto merge is on by default, so simply loading the page posts enabled:true
  // and the real server would start a live auto-merge scan against GitHub --
  // which reaches the network and never lets the listener close. Stub it so
  // this test stays about the content security policy and nothing else.
  await page.route("**/api/auto-merge", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, running: false, candidates: [] })
    })
  );
  // Holding app.js back leaves only the pre-paint script's work on the page, so
  // the theme found there is the one a user sees before the dashboard boots --
  // not the one applyTheme() would have set a moment later either way.
  if (blockAppJs) await page.route("**/app.js", (route) => route.abort());

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

  async function close() {
    await browser.close();
    await new Promise((resolve) => listener.close(resolve));
  }

  return { page, close, violations, port };
}

async function reportedViolations(page, consoleViolations) {
  const fromPage = await page.evaluate(() => window.__cspViolations || []);
  return [...fromPage.map((entry) => `${entry.directive} blocked ${entry.blocked}`), ...consoleViolations];
}

test("the policy grants scripts no inline escape hatch", () => {
  const directives = new Map(
    SECURITY_HEADERS["content-security-policy"]
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .map(([name, ...values]) => [name, values])
  );
  // Loosening this to 'unsafe-inline' would make the extracted theme script
  // unnecessary and quietly re-open the hole it was moved out of.
  assert.deepEqual(directives.get("script-src"), ["'self'"]);
});

test("the dashboard loads with no content security policy violations", { skip }, async () => {
  const { page, close, violations } = await openAgainstServer();
  try {
    await page.waitForSelector(".shell");
    assert.deepEqual(await reportedViolations(page, violations), []);
  } finally {
    await close();
  }
});

test("a stored light theme is applied before the app script runs", { skip }, async () => {
  const { page, close, violations } = await openAgainstServer({
    storedSettings: { theme: "light" },
    blockAppJs: true
  });
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    assert.deepEqual(await reportedViolations(page, violations), []);
  } finally {
    await close();
  }
});

test("an unreadable settings entry still paints a theme before the app script runs", { skip }, async () => {
  const { page, close } = await openAgainstServer({ blockAppJs: true });
  try {
    await page.evaluate(() => localStorage.setItem("pr-deck:v1", "{not json"));
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  } finally {
    await close();
  }
});

test("the theme script is served as its own file", { skip }, async () => {
  const { close, port } = await openAgainstServer();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/theme.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(response.headers.get("content-security-policy") || "", /script-src 'self'/);
    assert.match(await response.text(), /dataset\.theme/);
  } finally {
    await close();
  }
});
