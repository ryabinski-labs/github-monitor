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

const failedPr = {
  repo: "acme/store",
  number: 42,
  numberLabel: "#42",
  title: "Fix checkout",
  author: "dev",
  state: "fail",
  checkCount: 2,
  failureReason: "unit and browser tests failed",
  url: "https://github.com/acme/store/pull/42",
  failedRuns: [
    { runId: 101, workflow: "Unit CI", url: "https://github.com/acme/store/actions/runs/101" },
    { runId: 102, workflow: "Browser CI", url: "https://github.com/acme/store/actions/runs/102" }
  ]
};

const failedCi = {
  kind: "workflowRun",
  runId: 201,
  repo: "acme/api",
  workflow: "CI",
  runNumber: "#18",
  title: "CI on main",
  branch: "main",
  status: "completed",
  conclusion: "failure",
  failureReason: "test failed",
  createdAt: "2026-08-17T10:00:00Z",
  url: "https://github.com/acme/api/actions/runs/201"
};

function failedCd(runId, runNumber) {
  return {
    runId,
    repo: "acme/store",
    workflow: "Deploy",
    runNumber: `#${runNumber}`,
    title: "Deploy production",
    branch: "main",
    status: "completed",
    conclusion: "failure",
    outcome: "failure",
    failureReason: "production smoke test failed",
    createdAt: "2026-08-17T10:05:00Z",
    url: `https://github.com/acme/store/actions/runs/${runId}`,
    changeSummary: {}
  };
}

const trace = {
  id: "acme/store#42",
  repo: "acme/store",
  prNumber: 42,
  numberLabel: "#42",
  title: "Fix checkout",
  author: "dev",
  prUrl: "https://github.com/acme/store/pull/42",
  baseRef: "main",
  startedAt: "2026-08-17T09:00:00Z",
  lastEvidenceAt: "2026-08-17T10:05:00Z",
  status: "flagged",
  severity: "critical",
  reason: "Production CD failed.",
  failedRuns: [{ runId: 301, workflow: "Deploy", url: "https://github.com/acme/store/actions/runs/301" }],
  nextAction: { label: "Open failed run", url: "https://github.com/acme/store/actions/runs/301" },
  evidence: [],
  rule: { source: "auto" },
  stages: [
    { key: "pr_opened", label: "PR opened", status: "complete" },
    { key: "ci_complete", label: "CI complete", status: "complete" },
    { key: "merged", label: "Merged", status: "complete" },
    { key: "cd_started", label: "CD started", status: "complete" },
    { key: "prod_complete", label: "Production complete", status: "blocked" }
  ]
};

const statusFixture = {
  account: "maintainer",
  accounts: ["acme"],
  generatedAt: "2026-08-17T10:10:00Z",
  warnings: [],
  options: {},
  autoMerge: { enabled: false, items: [] },
  summary: {
    repos: 2,
    passingPrs: 0,
    noCiPrs: 0,
    failingPrs: 2,
    conflictPrs: 0,
    runningPrs: 0,
    runningCd: 0,
    finishedCd: 1,
    failedCd: 1,
    skippedCd: 0,
    runningDeployments: 0,
    busyRunners: 0,
    flaggedJourneys: 1,
    activeJourneys: 0,
    shippedJourneys: 0,
    tracingUnknown: 0
  },
  pullRequests: { pass: [], noCi: [], fail: [failedPr], running: [], conflicts: [] },
  actions: { failed: [failedCi], running: [] },
  cd: { running: [], failed: [failedCd(301, 30)], finished: [failedCd(302, 29)] },
  deployments: { running: [] },
  runners: { busy: [] },
  traces: { flagged: [trace], active: [], completed: [], unknown: [] },
  refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
  rateLimit: { core: { remaining: 5000, limit: 5000 } }
};

async function openDashboard() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const rerunRequests = [];
  await page.addInitScript(() => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "fail", traceFilter: "flagged" }));
    localStorage.removeItem("pr-deck:dismissed:v1");
    localStorage.removeItem("pr-deck:traces:v1");
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture) });
    if (pathname === "/api/actions/rerun-failed") {
      rerunRequests.push(request.postDataJSON());
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ queued: true }) });
    }
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForSelector(".rerun-button");
  return { browser, page, rerunRequests };
}

test("rerun controls cover failed CI, CD, history, PR, and trace surfaces", { skip }, async () => {
  const { browser, page, rerunRequests } = await openDashboard();
  try {
    const failButtons = page.locator(".rerun-button");
    assert.equal(await failButtons.count(), 2);
    assert.deepEqual(await failButtons.allInnerTexts(), ["RERUN 2 WORKFLOWS", "RERUN FAILED"]);

    await failButtons.nth(1).click();
    await page.getByRole("button", { name: /Rerun queued.*CI #18/ }).waitFor();
    assert.deepEqual(rerunRequests, [{ repo: "acme/api", runId: 201 }]);

    await page.reload();
    const reloadedCiButton = page.getByRole("button", { name: /Rerun queued.*CI #18/ });
    await reloadedCiButton.waitFor();
    assert.equal(await reloadedCiButton.isDisabled(), true);
    assert.deepEqual(rerunRequests, [{ repo: "acme/api", runId: 201 }]);

    await failButtons.nth(0).click();
    await page.getByRole("button", { name: /Rerun queued.*2 failed workflows/ }).waitFor();
    assert.deepEqual(rerunRequests.slice(1).sort((a, b) => a.runId - b.runId), [
      { repo: "acme/store", runId: 101 },
      { repo: "acme/store", runId: 102 }
    ]);

    await page.locator(".rail-item[data-view='failedCd']").click();
    const failedCdButton = page.getByRole("button", { name: /Rerun failed.*Deploy #30/ });
    await failedCdButton.click();
    await page.getByRole("button", { name: /Rerun queued.*Deploy #30/ }).waitFor();

    await page.locator(".rail-item[data-view='finishedCd']").click();
    const historyButton = page.getByRole("button", { name: /Rerun failed.*Deploy #29/ });
    await historyButton.click();
    await page.getByRole("button", { name: /Rerun queued.*Deploy #29/ }).waitFor();

    await page.locator(".rail-item[data-view='pipelineTraces']").click();
    const traceButton = page.getByRole("button", { name: /Rerun queued.*Deploy.*acme\/store/ });
    assert.equal(await traceButton.count(), 1);
    assert.equal(await traceButton.isDisabled(), true);

    assert.deepEqual(rerunRequests.slice(-2), [
      { repo: "acme/store", runId: 301 },
      { repo: "acme/store", runId: 302 }
    ]);
  } finally {
    await browser.close();
  }
});

test("rerun controls wrap without horizontal overflow on a narrow screen", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    for (const { width, height } of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
      await page.setViewportSize({ width, height });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `page overflows horizontally by ${overflow}px at ${width}px`);
      const button = page.getByRole("button", { name: /Rerun 2 failed workflows/ });
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `rerun action stays inside the ${width}px viewport`);
      assert.ok(box.height >= 44, `mobile rerun action is only ${box.height}px high at ${width}px`);
      const contentFits = await button.evaluate((element) => {
        const buttonBox = element.getBoundingClientRect();
        const iconBox = element.querySelector("svg")?.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1
          && (!iconBox || (iconBox.left >= buttonBox.left && iconBox.right <= buttonBox.right));
      });
      assert.equal(contentFits, true, `rerun label and icon stay inside the button at ${width}px`);
    }
  } finally {
    await browser.close();
  }
});

test("failed action cards and trace controls stay visible at constrained dashboard widths", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    for (const width of [768, 1001, 1024, 1180, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ["fail", "failedCd", "finishedCd", "pipelineTraces"]) {
        await page.locator(`.rail-item[data-view='${view}']`).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${view} overflows horizontally by ${overflow}px at ${width}px`);
        const actions = page.locator("#content .row-actions, #content .trace-head-actions").first();
        const box = await actions.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${view} actions stay inside the ${width}px viewport`);
      }
    }
  } finally {
    await browser.close();
  }
});
