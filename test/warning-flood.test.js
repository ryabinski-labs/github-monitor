import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import {
  dependabotCleanupSnapshot,
  resetDependabotCleanupState,
  resetObservedRateBuckets,
  runDependabotQueueScan,
  summarizeScanErrors
} from "../server.js";

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
// Optional so this harness keeps working either side of the pre-paint theme
// script being split out of index.html.
const themeJsPath = path.join(root, "public/theme.js");
const themeJs = existsSync(themeJsPath) ? readFileSync(themeJsPath, "utf8") : null;

const REPOS = Array.from({ length: 85 }, (_, index) => `owner/repo-${index}`);
const ENDPOINTS = ["pull requests", "queued runs", "in_progress runs", "waiting runs", "requested runs", "pending runs"];
const QUOTA_CAUSE = "GitHub API quota is too low for Dependabot cleanup.";

// The shape the dashboard actually produced: one failure per repo per endpoint,
// every one of them carrying the same cause.
function floodedScanErrors() {
  return REPOS.flatMap((repo) => ENDPOINTS.map((endpoint) => `${repo} ${endpoint}: ${QUOTA_CAUSE}`));
}

test("a cause repeated across every repo collapses to one counted line", () => {
  const errors = floodedScanErrors();
  assert.equal(errors.length, 510, "the fixture reproduces the reported scale");

  const summary = summarizeScanErrors(errors);

  assert.equal(summary, `${QUOTA_CAUSE} (510 checks)`);
  assert.ok(summary.length < 120, `summary stayed short, got ${summary.length} characters`);
});

test("distinct causes survive the collapse, capped and counted", () => {
  const summary = summarizeScanErrors([
    ...Array.from({ length: 5 }, (_, index) => `owner/a${index} pull requests: Quota too low.`),
    ...Array.from({ length: 3 }, (_, index) => `owner/b${index} queued runs: Bad credentials.`),
    "owner/c1 waiting runs: Not Found.",
    "owner/d1 pending runs: Server error.",
    "owner/e1 requested runs: Timeout."
  ]);

  assert.match(summary, /Quota too low\. \(5 checks\)/);
  assert.match(summary, /Bad credentials\. \(3 checks\)/);
  // A cause seen once keeps its subject, so a single broken repo is still nameable.
  assert.match(summary, /owner\/c1 waiting runs: Not Found\./);
  assert.match(summary, /\+2 more causes/);
});

test("an empty error list produces no warning at all", () => {
  assert.equal(summarizeScanErrors([]), "");
  assert.equal(summarizeScanErrors(["", "   ", null, undefined]), "");
});

function status(warnings) {
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: new Date().toISOString(),
    warnings,
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 85,
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
    }
  };
}

async function measurePanel(page, warnings) {
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
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(status(warnings)) });
    }
    if (pathname === "/favicon.svg") {
      return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForFunction(() => document.querySelector("#generatedAt")?.textContent !== "never");
  await page.locator("#errorPanel").waitFor({ state: "visible" });

  const measurement = await page.evaluate(() => {
    const panel = document.querySelector("#errorPanel");
    return {
      height: panel.getBoundingClientRect().height,
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      textLength: panel.textContent.length,
      documentHeight: document.documentElement.scrollHeight
    };
  });
  await page.unroute("**/*");
  return measurement;
}

test("a warning built from every repo cannot push the dashboard off-screen", { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 320, height: 568 });

    const brief = await measurePanel(page, ["GitHub core API quota is exhausted; refresh is paused."]);
    // The pre-fix payload: every repo failure spelled out in a single warning.
    const flooded = await measurePanel(page, [`Dependabot cleanup: ${floodedScanErrors().join("; ")}`]);

    assert.ok(
      flooded.textLength > 30000,
      `the fixture still delivers an oversized warning, got ${flooded.textLength} characters`
    );
    assert.ok(
      flooded.height <= 120,
      `the flooded panel stays capped, got ${Math.round(flooded.height)}px`
    );
    // Nothing is silently dropped -- the overflow is reachable by scrolling.
    assert.ok(
      flooded.scrollHeight > flooded.clientHeight,
      "the clamped panel scrolls rather than truncating the warning"
    );
    // The real regression: the page must be no taller than it is with one short
    // warning, which is what "the banner ate the dashboard" actually means.
    assert.ok(
      flooded.documentHeight - brief.documentHeight <= 150,
      `the flood adds little page height, brief ${brief.documentHeight}px vs flooded ${flooded.documentHeight}px`
    );
  } finally {
    await browser.close();
  }
});

test("a scan that fails on every repo reports one collapsed warning, not one per repo", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const now = Date.parse("2026-08-30T08:14:00Z");
  const repos = Array.from({ length: 85 }, (_, index) => `flood-owner/repo-${index}`);

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4900",
      "x-ratelimit-reset": String(Math.floor(now / 1000) + 3600),
      "x-ratelimit-resource": "core"
    };
    if (requestUrl.pathname === "/user") return Response.json({ login: "flood-user" }, { headers });
    if (requestUrl.pathname === "/user/orgs") return Response.json([{ login: "flood-owner" }], { headers });
    if (requestUrl.pathname === "/orgs/flood-owner/repos") {
      return Response.json(repos.map((repo) => ({ full_name: repo, archived: false })), { headers });
    }
    // Discovery succeeds and stays under the threshold, so the destructive half
    // never runs -- this test is only about how the failures get reported.
    if (/^\/repos\/flood-owner\/repo-\d+\/actions\/runs$/.test(requestUrl.pathname)) {
      return Response.json({ workflow_runs: [] }, { headers });
    }
    // Every repo's pull request listing fails with the same cause, which is the
    // shape a quota block produces across a whole account.
    if (/^\/repos\/flood-owner\/repo-\d+\/pulls$/.test(requestUrl.pathname) && options.method === "GET") {
      return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  resetDependabotCleanupState();
  resetObservedRateBuckets();
  try {
    await runDependabotQueueScan({ threshold: 1000, owners: ["flood-owner"], jobs: 4, now });
    const { lastError } = dependabotCleanupSnapshot();

    assert.match(lastError, /\(85 checks\)/, `expected a counted single cause, got: ${lastError.slice(0, 200)}`);
    // The defect was naming all 85 repos in one warning; none should survive.
    assert.doesNotMatch(lastError, /repo-\d+/);
    assert.ok(lastError.length < 200, `warning stayed short, got ${lastError.length} characters`);
  } finally {
    resetDependabotCleanupState();
    resetObservedRateBuckets();
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("a repeated cause carrying no subject is reported intact", () => {
  // cleanupDependabotWorkload pushes this one with no `subject: ` prefix, so the
  // summary has nothing to strip and must not shorten the sentence itself.
  const bare = "GitHub API quota became too low before Dependabot mutations started.";
  assert.equal(summarizeScanErrors([bare, bare, bare]), `${bare} (3 checks)`);
  assert.equal(summarizeScanErrors([bare]), bare);
});
