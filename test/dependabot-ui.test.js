// Browser coverage for the Dependabot vulnerability view. public/app.js has no
// exports, so the rail item, the three Security tiles, the project row and the
// "not checked" disclosure are proven through a real page.
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
const axeJs = readFileSync(path.join(root, "node_modules/axe-core/axe.min.js"), "utf8");

function statusFixture({ repos = [], unchecked = [], counts = {}, checking = false } = {}) {
  const summaryCounts = {
    vulnerableRepos: counts.vulnerableRepos ?? repos.length,
    criticalAlerts: counts.criticalAlerts ?? repos.reduce((total, row) => total + row.critical, 0),
    highAlerts: counts.highAlerts ?? repos.reduce((total, row) => total + row.high, 0),
    reposChecked: counts.reposChecked ?? 4,
    reposTotal: counts.reposTotal ?? 5,
    uncheckedRepos: counts.uncheckedRepos ?? unchecked.length
  };
  const checkedAt = summaryCounts.reposChecked > 0
    ? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    : "";
  return {
    account: "ryabinski-labs",
    accounts: ["ryabinski-labs"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    scan: {},
    autoMerge: { enabled: false, items: [] },
    autoRerun: { enabled: false },
    summary: {
      repos: 5,
      passingPrs: 0,
      noCiPrs: 0,
      failingPrs: 0,
      conflictPrs: 0,
      behindPrs: 0,
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
      tracingUnknown: 0,
      ...summaryCounts
    },
    pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [], behind: [] },
    actions: { failed: [], running: [] },
    cd: { running: [], failed: [], finished: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    dependabot: {
      repos,
      unchecked,
      checkedAt,
      checking,
      error: "",
      counts: summaryCounts
    },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

function vulnerableRepo(overrides = {}) {
  return {
    repo: "ryabinski-labs/github-monitor",
    critical: 2,
    high: 3,
    oldestAt: new Date(Date.now() - 34 * 86400000).toISOString(),
    url: "https://github.com/ryabinski-labs/github-monitor/security/dependabot",
    checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides
  };
}

async function openDashboard({ statuses, theme = "dark" } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const queue = [...statuses];

  await page.addInitScript(
    ([storedTheme]) => {
      localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "vulnerabilities", theme: storedTheme }));
      for (const key of ["dismissed", "notified", "inbox", "status"]) {
        localStorage.removeItem(`pr-deck:${key}:v1`);
      }
    },
    [theme]
  );

  await page.route("**/*", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (pathname === "/api/status") {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(next) });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForFunction(() => localStorage.getItem("pr-deck:status:v1") !== null, null, { timeout: 5000 });
  await page.locator('.rail-item[data-view="vulnerabilities"]').click();
  await page.waitForSelector('#content[data-view="vulnerabilities"] .row-vulnerability');
  return { browser, page };
}

test("the vulnerability view shows the project, both severities, age, link and unchecked projects", { skip }, async () => {
  const fixture = statusFixture({
    repos: [vulnerableRepo()],
    unchecked: [{ repo: "cigan1/quiet-project", reason: "Dependabot alerts are disabled for this repository." }]
  });
  const { browser, page } = await openDashboard({ statuses: [fixture] });
  try {
    assert.equal(await page.locator("#viewKicker").textContent(), "Dependabot alerts");
    assert.equal(await page.locator("#viewTitle").textContent(), "Projects with open critical and high vulnerabilities");
    assert.equal(await page.locator("#navVulnerabilities").textContent(), "1");
    assert.equal(
      await page.locator('.rail-item[data-view="vulnerabilities"]').getAttribute("aria-current"),
      "true"
    );

    const row = page.locator(".row-vulnerability");
    assert.match(await row.textContent(), /ryabinski-labs\/github-monitor/);
    assert.match(await row.textContent(), /2 critical/);
    assert.match(await row.textContent(), /3 high/);
    assert.match(await row.textContent(), /Oldest 34d/);
    assert.equal(
      await row.locator("a.open-link").getAttribute("href"),
      "https://github.com/ryabinski-labs/github-monitor/security/dependabot"
    );

    assert.match(await page.locator(".vuln-status").textContent(), /Checked .* ago .* 4 of 5 projects .* 2 critical .* 3 high/);
    assert.match(await page.locator(".vuln-notice summary").textContent(), /1 project not checked/);
    assert.match(await page.locator(".vuln-notice").textContent(), /cigan1\/quiet-project/);
    assert.match(await page.locator(".vuln-notice").textContent(), /Dependabot alerts are disabled/);

    await page.addScriptTag({ content: axeJs });
    const findings = await page.evaluate(async () => {
      const result = await window.axe.run("#content", {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
        rules: { "color-contrast": { enabled: false } }
      });
      return [
        ...result.violations.map((violation) => `violation ${violation.id}: ${violation.nodes.length} node(s)`),
        ...result.incomplete.map((violation) => `incomplete ${violation.id}: ${violation.nodes.length} node(s)`)
      ];
    });
    assert.deepEqual(findings, [], `vulnerability view must report no axe findings, got: ${findings.join("; ")}`);
  } finally {
    await browser.close();
  }
});

test("filtering by a severity narrows the rows and the rail badge", { skip }, async () => {
  const fixture = statusFixture({
    repos: [
      vulnerableRepo(),
      vulnerableRepo({ repo: "siftfy/siftfy-api", critical: 0, high: 2, url: "https://github.com/siftfy/siftfy-api/security/dependabot" })
    ]
  });
  const { browser, page } = await openDashboard({ statuses: [fixture] });
  try {
    assert.equal(await page.locator(".row-vulnerability").count(), 2);
    await page.locator("#filter").fill("critical");
    await page.waitForFunction(() => document.querySelectorAll(".row-vulnerability").length === 1);
    const rows = page.locator(".row-vulnerability");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().textContent(), /ryabinski-labs\/github-monitor/);
    assert.equal(await page.locator("#navVulnerabilities").textContent(), "1");
    assert.equal(await page.locator("#navVulnerabilities + .rail-total").textContent(), "of 2");
  } finally {
    await browser.close();
  }
});

test("an all-unchecked scan never reads as a clean account", { skip }, async () => {
  const fixture = statusFixture({
    repos: [],
    unchecked: [{ repo: "cigan1/quiet-project", reason: "Permission to read Dependabot alerts was denied." }],
    counts: { vulnerableRepos: 0, criticalAlerts: 0, highAlerts: 0, reposChecked: 0, reposTotal: 1, uncheckedRepos: 1 }
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.addInitScript(() => {
      localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "vulnerabilities", theme: "dark" }));
      localStorage.removeItem("pr-deck:status:v1");
    });
    await page.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
      if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
      if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
      if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
      if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture) });
      if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
      return route.fulfill({ status: 204, body: "" });
    });
    await page.goto("http://localhost/");
    await page.waitForFunction(() => localStorage.getItem("pr-deck:status:v1") !== null, null, { timeout: 5000 });
    await page.waitForSelector('#content[data-view="vulnerabilities"] .empty');
    assert.match(await page.locator(".vuln-status").textContent(), /No projects could be checked/);
    const text = await page.locator(".empty").textContent();
    assert.match(text, /No readable project has an open critical or high alert/);
    assert.match(text, /1 project could not be checked/);
    assert.doesNotMatch(text, /No open critical or high Dependabot alerts\.$/);
  } finally {
    await browser.close();
  }
});
