// Red-phase browser coverage for issue #142: the CD row layout.
//
// A running / finished / failed CD row must keep its branch-and-time meta on
// one line, give the title the row's flexible space instead of a sliver while
// the short "Deploy #1304" meta stretches, and spell running statuses as words
// (`In progress`, not `in_progress`). public/app.js is a browser script with no
// exports, so these render-layer rules are proven through a real page, the same
// way test/behind-base-ui.test.js proves the Out of date lane.
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
const asset = (relative) => readFileSync(path.join(root, relative), "utf8");
const indexHtml = asset("public/index.html");
const appJs = asset("public/app.js");
const themeJs = asset("public/theme.js");
const stylesCss = asset("public/styles.css");

// --- fixtures ----------------------------------------------------------------

function runningCd(overrides = {}) {
  return {
    repo: "ryabinski-labs/vectraseo",
    title: "Merge pull request #1651 from ryabinski-labs/fix/held-button-only-whitespace",
    workflow: "Deploy",
    runNumber: 1304,
    status: "pending",
    branch: "main",
    createdAt: "2026-09-24T06:06:00Z",
    url: "https://github.com/ryabinski-labs/vectraseo/actions/runs/35985309217",
    ...overrides
  };
}

function finishedCd(overrides = {}) {
  return {
    repo: "ryabinski-labs/vectraseo",
    title: "Merge pull request #1650 from ryabinski-labs/fix/console-release-tag",
    workflow: "Deploy",
    runNumber: 1302,
    status: "completed",
    conclusion: "success",
    outcome: "success",
    branch: "main",
    createdAt: "2026-09-24T05:40:00Z",
    url: "https://github.com/ryabinski-labs/vectraseo/actions/runs/35984309217",
    changeSummary: {},
    ...overrides
  };
}

function failedCd(overrides = {}) {
  return {
    repo: "ryabinski-labs/Sendant",
    title: "iOS 1.0.4 (19) · testflight",
    workflow: "iOS CD · Archive and TestFlight",
    runNumber: 12,
    status: "completed",
    conclusion: "failure",
    outcome: "failure",
    failureReason: "testflight failed",
    branch: "main",
    createdAt: "2026-09-24T05:57:00Z",
    url: "https://github.com/ryabinski-labs/Sendant/actions/runs/1",
    ...overrides
  };
}

function statusFixture() {
  return {
    account: "ryabinski-labs",
    accounts: ["ryabinski-labs"],
    generatedAt: "2026-09-24T10:00:00Z",
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 1,
      passingPrs: 0,
      noCiPrs: 0,
      failingPrs: 0,
      conflictPrs: 0,
      behindPrs: 0,
      runningPrs: 0,
      runningCd: 2,
      finishedCd: 1,
      failedCd: 1,
      skippedCd: 0,
      runningDeployments: 0,
      busyRunners: 0,
      flaggedJourneys: 0,
      activeJourneys: 0,
      shippedJourneys: 0,
      tracingUnknown: 0
    },
    pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [], behind: [] },
    actions: { failed: [], running: [] },
    cd: {
      running: [
        runningCd(),
        runningCd({
          status: "in_progress",
          runNumber: 1303,
          title: "Merge pull request #1652 from ryabinski-labs/fix/first-party-unsourced",
          url: "https://github.com/ryabinski-labs/vectraseo/actions/runs/35985303573"
        })
      ],
      failed: [failedCd()],
      finished: [finishedCd()]
    },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

// --- harness -----------------------------------------------------------------

// `viewport` is explicit on every call: the desktop layout is the defect, and
// the default 1280x720 would exercise the two-column fallback instead.
async function openDashboard({ view = "runningCd", viewport = { width: 1440, height: 900 } } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });

  await page.addInitScript(([storedView]) => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: storedView, theme: "dark" }));
    localStorage.removeItem("pr-deck:dismissed:v1");
    localStorage.removeItem("pr-deck:notified:v1");
    localStorage.removeItem("pr-deck:inbox:v1");
  }, [view]);

  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusFixture()) });
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("#rail");
  await page.locator(`.rail-item[data-view="${view}"]`).click();
  return { browser, page };
}

// Geometry read straight from the rendered boxes. `rowSelector` matches the
// grid element itself: an article.row for running and failed CD rows, the
// .cd-card-head of a finished CD card.
function measureRows(rowSelector) {
  const rows = [...document.querySelectorAll(rowSelector)];
  return rows.map((row) => {
    const title = row.querySelector(".title");
    const metas = [...row.querySelectorAll(":scope > .meta")];
    const tag = row.querySelector(".tag-group, .tag");
    const timeMeta = metas[metas.length - 1];
    // One-line oracle: both metas share a font, so a single-line pair has equal
    // heights. Not range rects -- an ellipsised, clipped line reports two of
    // them, and not computed line-height, which is "normal" (px-parsing yields
    // NaN) on this element.
    return {
      titleWidth: title.getBoundingClientRect().width,
      titleRight: title.getBoundingClientRect().right,
      tagLeft: tag.getBoundingClientRect().left,
      workflowMetaWidth: metas[0].getBoundingClientRect().width,
      timeMetaWidth: timeMeta.getBoundingClientRect().width,
      timeMetaText: timeMeta.textContent.trim(),
      metaHeights: metas.map((meta) => meta.getBoundingClientRect().height),
      timeMetaRight: timeMeta.getBoundingClientRect().right,
      rowRight: row.getBoundingClientRect().right,
      tags: [...row.querySelectorAll(".tag")].map((element) => element.textContent.trim())
    };
  });
}

// --- the defect --------------------------------------------------------------

test("the running CD row keeps its branch and time meta on one line at 1440px", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "runningCd" });
  try {
    const rows = await page.evaluate(measureRows, "#content .row");
    assert.equal(rows.length, 2, "the lane must render both live runs");
    for (const row of rows) {
      const [workflowHeight, timeHeight] = row.metaHeights;
      assert.ok(
        Math.abs(workflowHeight - timeHeight) <= 1,
        `"${row.timeMetaText}" must stay on one line, not orphan its AM onto a second line (meta heights ${workflowHeight}px and ${timeHeight}px)`
      );
    }
  } finally {
    await browser.close();
  }
});

test("the CD row gives the title the flexible space at 1440px", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "runningCd" });
  try {
    const rows = await page.evaluate(measureRows, "#content .row");
    for (const row of rows) {
      assert.ok(
        row.workflowMetaWidth <= 140,
        `"Deploy #1304" must sit at its natural width, not stretch over the row (${Math.round(row.workflowMetaWidth)}px)`
      );
      assert.ok(
        row.titleWidth > row.workflowMetaWidth + row.timeMetaWidth,
        `the title column must out-earn both metas combined (title ${Math.round(row.titleWidth)}px vs metas ${Math.round(row.workflowMetaWidth)}px + ${Math.round(row.timeMetaWidth)}px)`
      );
    }
  } finally {
    await browser.close();
  }
});

test("running CD statuses read as words, not raw enums", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "runningCd" });
  try {
    const tags = (await page.evaluate(measureRows, "#content .row")).flatMap((row) => row.tags);
    for (const tag of tags) {
      assert.ok(!tag.includes("_"), `"${tag}" still shows a raw enum to the operator`);
    }
    assert.deepEqual(tags, ["Pending", "In progress"], "the running statuses must be humanized");
  } finally {
    await browser.close();
  }
});

test("the finished CD row keeps its branch and time meta on one line at 1440px", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "finishedCd" });
  try {
    const rows = await page.evaluate(measureRows, "#content .cd-card-head");
    assert.equal(rows.length, 1, "the lane must render the finished run");
    for (const row of rows) {
      const [workflowHeight, timeHeight] = row.metaHeights;
      assert.ok(
        Math.abs(workflowHeight - timeHeight) <= 1,
        `"${row.timeMetaText}" must stay on one line (meta heights ${workflowHeight}px and ${timeHeight}px)`
      );
      assert.ok(
        row.workflowMetaWidth <= 140,
        `"Deploy #1302" must sit at its natural width, not stretch over the row (${Math.round(row.workflowMetaWidth)}px)`
      );
      assert.ok(
        row.titleWidth > row.workflowMetaWidth + row.timeMetaWidth,
        `the finished CD title must out-earn both metas combined`
      );
    }
  } finally {
    await browser.close();
  }
});

test("the failed CD row keeps its reason and time on one line", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "failedCd" });
  try {
    const rows = await page.evaluate(measureRows, "#content .row");
    assert.equal(rows.length, 1, "the lane must render the failed run");
    const [row] = rows;
    assert.ok(row.timeMetaText.startsWith("Reason:"), "the row must carry the failure reason");
    const [workflowHeight, timeHeight] = row.metaHeights;
    assert.ok(
      Math.abs(workflowHeight - timeHeight) <= 1,
      `"${row.timeMetaText}" must stay on one line (meta heights ${workflowHeight}px and ${timeHeight}px)`
    );
    assert.ok(
      row.timeMetaWidth >= 240 && row.timeMetaWidth <= 322,
      `the failed row's reason and time earn the wider track, not the running row's cap (${Math.round(row.timeMetaWidth)}px)`
    );
  } finally {
    await browser.close();
  }
});

test("the CD row stays inside a 390px viewport", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "runningCd", viewport: { width: 390, height: 844 } });
  try {
    const rows = await page.evaluate(measureRows, "#content .row");
    assert.equal(rows.length, 2, "the lane must render both live runs on mobile");
    for (const row of rows) {
      assert.ok(
        row.timeMetaRight <= row.rowRight + 1,
        `"${row.timeMetaText}" must not overflow the row on a 390px viewport`
      );
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `the page must not scroll sideways on mobile (overflow ${overflow}px)`);
  } finally {
    await browser.close();
  }
});
