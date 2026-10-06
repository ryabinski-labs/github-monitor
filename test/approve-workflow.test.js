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

const heldPr = {
  repo: "acme/store",
  number: 7,
  numberLabel: "#7",
  title: "Add feature from fork",
  author: "contributor",
  state: "pass",
  checkCount: 2,
  mergeable: "MERGEABLE",
  isDraft: false,
  hasConflict: false,
  url: "https://github.com/acme/store/pull/7",
  awaitingApprovalRuns: [
    { runId: 900, workflow: "CI", url: "https://github.com/acme/store/actions/runs/900" },
    { runId: 901, workflow: "CodeQL", url: "https://github.com/acme/store/actions/runs/901" }
  ],
  awaitingApprovalCount: 2
};

const statusFixture = {
  account: "maintainer",
  accounts: ["acme"],
  generatedAt: "2026-08-17T10:10:00Z",
  warnings: [],
  options: {},
  autoMerge: { enabled: false, items: [] },
  summary: {
    repos: 1,
    passingPrs: 1,
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
  pullRequests: { pass: [heldPr], noCi: [], fail: [], running: [], conflicts: [], behind: [] },
  actions: { failed: [], running: [] },
  cd: { running: [], failed: [], finished: [] },
  deployments: { running: [] },
  runners: { busy: [] },
  traces: { flagged: [], active: [], completed: [], unknown: [] },
  refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
  rateLimit: { core: { remaining: 5000, limit: 5000 } }
};

async function openDashboard() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const approveRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "pass" }));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture) });
    if (pathname === "/api/actions/approve-run") {
      approveRequests.push(request.postDataJSON());
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ approved: true }) });
    }
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForSelector(".approve-button");
  return { browser, page, approveRequests };
}

test("held workflows expose an approve control and an awaiting-approval badge", { skip }, async () => {
  const { browser, page, approveRequests } = await openDashboard();
  try {
    const badge = page.locator(".approval-pill");
    assert.equal(await badge.count(), 1);
    assert.match(await badge.innerText(), /2 AWAITING APPROVAL/i);

    const button = page.locator(".approve-button");
    assert.match(await button.innerText(), /APPROVE 2 WORKFLOWS/i);

    await button.click();
    await page.getByRole("button", { name: /Approval sent.*2 workflows awaiting approval/ }).waitFor();
    assert.deepEqual(approveRequests.slice().sort((a, b) => a.runId - b.runId), [
      { repo: "acme/store", runId: 900 },
      { repo: "acme/store", runId: 901 }
    ]);

    await page.reload();
    const reloaded = page.locator(".approve-button");
    await reloaded.waitFor();
    assert.equal(await reloaded.isDisabled(), true);
    assert.match(await reloaded.innerText(), /APPROVED/i);
    assert.equal(approveRequests.length, 2);
  } finally {
    await browser.close();
  }
});

test("approve control wraps without horizontal overflow on a narrow screen", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    for (const { width, height } of [{ width: 375, height: 667 }, { width: 430, height: 932 }]) {
      await page.setViewportSize({ width, height });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `page overflows horizontally by ${overflow}px at ${width}px`);
      const button = page.locator(".approve-button");
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `approve action stays inside the ${width}px viewport`);
      assert.ok(box.height >= 28, `approve action is only ${box.height}px high at ${width}px`);
    }
  } finally {
    await browser.close();
  }
});
