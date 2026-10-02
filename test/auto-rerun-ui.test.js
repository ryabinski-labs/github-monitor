// The dashboard half of auto rerun: the switch mirrors and writes the server
// setting, a failed row says what auto rerun did with it, and a run that failed
// again after its automatic rerun raises an alert exactly once.

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
const files = {
  "/index.html": ["text/html", readFileSync(path.join(root, "public/index.html"), "utf8")],
  "/app.js": ["text/javascript", readFileSync(path.join(root, "public/app.js"), "utf8")],
  "/theme.js": ["text/javascript", readFileSync(path.join(root, "public/theme.js"), "utf8")],
  "/styles.css": ["text/css", readFileSync(path.join(root, "public/styles.css"), "utf8")]
};

const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();

const exhaustedCi = {
  kind: "workflowRun",
  runId: 201,
  repo: "acme/api",
  workflow: "CI",
  runNumber: "#18",
  title: "CI on main",
  branch: "main",
  status: "completed",
  conclusion: "failure",
  failureReason: "runner lost communication",
  createdAt: recent,
  runAttempt: 2,
  url: "https://github.com/acme/api/actions/runs/201",
  autoRerun: { state: "exhausted", attempt: 2 }
};

const rerunPr = {
  repo: "acme/store",
  number: 42,
  numberLabel: "#42",
  title: "Fix checkout",
  author: "dev",
  state: "fail",
  checkCount: 1,
  failureReason: "build failed",
  url: "https://github.com/acme/store/pull/42",
  failedRuns: [{ runId: 101, workflow: "Build", url: "", autoRerun: { state: "requested", attempt: 2 } }],
  autoRerun: { state: "requested", attempt: 2 }
};

const statusFixture = {
  account: "maintainer",
  accounts: ["acme"],
  generatedAt: new Date().toISOString(),
  warnings: [],
  options: {},
  autoMerge: { enabled: false, configured: true, candidates: [] },
  autoRerun: { enabled: true, maxAttempts: 2, lastError: "" },
  summary: { repos: 2, failingPrs: 2 },
  pullRequests: { pass: [], noCi: [], fail: [rerunPr], running: [], conflicts: [], behind: [] },
  actions: { failed: [exhaustedCi], running: [] },
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
  const configWrites = [];
  let serverEnabled = true;
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "fail", notifications: false }));
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    let pathname = new URL(request.url()).pathname;
    if (pathname === "/") pathname = "/index.html";
    if (files[pathname]) return route.fulfill({ contentType: files[pathname][0], body: files[pathname][1] });
    if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture) });
    if (pathname === "/api/auto-rerun") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        configWrites.push(body);
        serverEnabled = Boolean(body.enabled);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ enabled: serverEnabled, maxAttempts: 2 }) });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForSelector(".rerun-pill");
  return { browser, page, configWrites };
}

test("failed rows show what auto rerun did and a failed retry alerts once", { skip }, async () => {
  const { browser, page, configWrites } = await openDashboard();
  try {
    assert.equal(await page.locator("#autoRerun").isChecked(), true, "the switch mirrors the server");
    assert.deepEqual(configWrites, [], "loading the page reads the setting, never writes it");

    const pills = await page.locator(".rerun-pill").allInnerTexts();
    assert.deepEqual(pills.map((text) => text.toLowerCase()).sort(), ["auto rerun #2", "failed after rerun"]);
    assert.equal(await page.locator(".rerun-pill-exhausted").count(), 1);

    // The inbox only renders its list while open.
    const alertTitles = async () => {
      if (!(await page.locator("#inboxToggle").getAttribute("aria-expanded") === "true")) {
        await page.locator("#inboxToggle").click();
      }
      return page.locator(".inbox-item").allInnerTexts();
    };
    const countAlerts = async () => (await alertTitles()).filter((text) => /Failed again after auto rerun/.test(text)).length;
    assert.equal(await countAlerts(), 1, "the exhausted run alerts");
    assert.equal((await alertTitles()).filter((text) => /Auto rerun requested/.test(text)).length, 1);

    await page.reload();
    await page.waitForSelector(".rerun-pill");
    assert.equal(await countAlerts(), 1, "a reload does not re-alert the same run");

    await page.keyboard.press("Escape");
    await page.locator("#autoRerun").uncheck();
    await page.waitForFunction(() => document.querySelector("#autoRerun").checked === false);
    assert.deepEqual(configWrites, [{ enabled: false }]);
  } finally {
    await browser.close();
  }
});
