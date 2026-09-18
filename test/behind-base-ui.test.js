// Red-phase browser coverage for the "Out of date" PR lane.
//
// Derived from docs/prd/pr-behind-base.md and docs/prd/pr-behind-base.ui.md via
// tdd/pr-behind-base.tdd.yaml. Scenario IDs appear verbatim in test names and
// are the join key to the artifact and to QA results -- never rename them.
//
// public/app.js is a browser script with no exports, so every rule that lives in
// the render layer has to be proven through a real page. That is why this file
// carries scenarios the pyramid would otherwise push down to unit level.
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

// --- fixtures ----------------------------------------------------------------

function behindPr(overrides = {}) {
  const number = overrides.number ?? 118;
  return {
    repo: "ryabinski-labs/github-monitor",
    number,
    numberLabel: `#${number}`,
    title: "Wait out post-merge CI",
    author: "cigan1",
    url: `https://github.com/ryabinski-labs/github-monitor/pull/${number}`,
    state: "pass",
    checkCount: 28,
    isDraft: false,
    hasConflict: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    behindBy: 12,
    runningChecks: [],
    ...overrides
  };
}

function statusFixture({ behind = [], pass = [], conflicts = [] } = {}) {
  return {
    account: "ryabinski-labs",
    accounts: ["ryabinski-labs"],
    generatedAt: "2026-09-18T05:45:00Z",
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 1,
      passingPrs: pass.length,
      noCiPrs: 0,
      failingPrs: 0,
      conflictPrs: conflicts.length,
      behindPrs: behind.length,
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
    pullRequests: { pass, noCi: [], fail: [], running: [], conflicts, behind },
    actions: { failed: [], running: [] },
    cd: { running: [], failed: [], finished: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

// --- harness -----------------------------------------------------------------

// `statuses` is a queue: each GET /api/status shifts one, the last one repeats.
// That is how a "next scan" is simulated after a mutation.
async function openDashboard({
  statuses = [statusFixture({ behind: [behindPr()] })],
  view = "behind",
  theme = "dark",
  updateBranch = { status: 200, body: { updated: true } }
} = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const posts = [];
  const queue = [...statuses];

  await page.addInitScript(
    ([storedView, storedTheme]) => {
      localStorage.setItem("pr-deck:v1", JSON.stringify({ view: storedView, theme: storedTheme }));
      localStorage.removeItem("pr-deck:dismissed:v1");
      localStorage.removeItem("pr-deck:notified:v1");
      localStorage.removeItem("pr-deck:inbox:v1");
    },
    [view, theme]
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

    if (pathname === "/api/pull-request/update-branch") {
      posts.push({ method: request.method(), body: request.postDataJSON?.() ?? null });
      if (updateBranch === "hang") return new Promise(() => {});
      if (updateBranch === "abort") return route.abort("connectionreset");
      return route.fulfill({
        status: updateBranch.status,
        contentType: "application/json",
        body: JSON.stringify(updateBranch.body)
      });
    }

    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("#rail");
  return { browser, page, posts };
}

async function railCount(page, id) {
  return page.evaluate((elementId) => document.getElementById(elementId)?.textContent ?? null, id);
}

async function selectBehindView(page) {
  const rail = page.locator('.rail-item[data-view="behind"]');
  assert.equal(
    await rail.count(),
    1,
    "the rail must carry an Out of date item -- without it the lane is unreachable and every assertion below is vacuous"
  );
  await rail.click();
}

// --- REQ-behind-lane ---------------------------------------------------------

test("SC-lane-rail-count: the rail count equals the size of the lane", { skip }, async () => {
  // Oracle: navBehind reads "4" and the view renders 4 rows
  const behind = [118, 119, 120, 121].map((number) => behindPr({ number }));
  const pass = [201, 202, 203, 204, 205, 206].map((number) => behindPr({ number, behindBy: 0 }));
  const { browser, page } = await openDashboard({ statuses: [statusFixture({ behind, pass })] });
  try {
    assert.equal(await railCount(page, "navBehind"), "4", "the rail count must equal the lane size");
    await selectBehindView(page);
    assert.equal(await page.locator("#content .row").count(), 4, "the lane must render one row per behind PR");
  } finally {
    await browser.close();
  }
});

test("SC-journey-unstick: the operator finds a stuck PR and unsticks it without leaving the dashboard", { skip }, async () => {
  // Oracle: navBehind "1" -> click -> follow-up scan -> navBehind "0", the PR is
  // back in Passing CI, and exactly 1 POST was recorded. This is the whole promise.
  const stuck = behindPr({ behindBy: 3 });
  const unstuck = behindPr({ behindBy: 0 });
  const { browser, page, posts } = await openDashboard({
    statuses: [statusFixture({ behind: [stuck] }), statusFixture({ behind: [], pass: [unstuck] })]
  });
  try {
    assert.equal(await railCount(page, "navBehind"), "1", "the stuck PR must be visible before the click");
    await selectBehindView(page);
    await page.locator(".update-button").first().click();
    await page.waitForFunction(() => document.querySelector("#navBehind")?.textContent === "0", null, { timeout: 5000 });

    assert.equal(await railCount(page, "navPass"), "1", "after the update the PR returns to Passing CI");
    assert.equal(posts.length, 1, "exactly one update request must have been issued");
    assert.equal(posts[0].method, "POST", "the update must be a POST");
  } finally {
    await browser.close();
  }
});

// --- REQ-conflict-precedence -------------------------------------------------

test("SC-precedence-no-update-button: a conflicting PR offers no Update branch button", { skip }, async () => {
  // Oracle: the conflicting row contains 0 .update-button elements.
  // GitHub answers 422 for an update on a conflicting PR, so the button would lie.
  const conflicting = behindPr({ hasConflict: true, behindBy: 9 });
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ conflicts: [conflicting] })],
    view: "conflicts"
  });
  try {
    assert.equal(
      await page.locator('.rail-item[data-view="behind"]').count(),
      1,
      "guard against a vacuous pass: with no Out of date lane shipped at all, 'this row has no update button' proves nothing"
    );
    await page.locator('.rail-item[data-view="conflicts"]').click();
    await page.waitForSelector("#content .row");
    assert.equal(
      await page.locator("#content .row .update-button").count(),
      0,
      "a conflicting PR must not offer an update that GitHub would reject"
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-update-button -------------------------------------------------------

test("SC-button-present-and-ordered: the button renders before Merge in the row actions", { skip }, async () => {
  // Oracle: within one .row-actions, .update-button precedes .merge-button
  const { browser, page } = await openDashboard();
  try {
    await selectBehindView(page);
    const order = await page.evaluate(() => {
      const actions = document.querySelector("#content .row .row-actions");
      if (!actions) return null;
      const buttons = [...actions.children];
      return {
        update: buttons.findIndex((el) => el.classList.contains("update-button")),
        merge: buttons.findIndex((el) => el.classList.contains("merge-button"))
      };
    });
    assert.ok(order, "the row must render an action group");
    assert.ok(order.update >= 0, "the row must carry an Update branch button");
    assert.ok(order.merge >= 0, "the row must keep its Merge button (DL-006)");
    assert.ok(order.update < order.merge, "Update branch is the lane's primary action and must come first");
  } finally {
    await browser.close();
  }
});

test("SC-button-inflight-single-request: a second click during the request issues no second request", { skip }, async () => {
  // Oracle: button disabled, text "Updating", exactly 1 POST recorded
  const { browser, page, posts } = await openDashboard({ updateBranch: "hang" });
  try {
    await selectBehindView(page);
    const button = page.locator(".update-button").first();
    await button.click();
    await page.waitForFunction(
      () => document.querySelector(".update-button")?.textContent?.trim() === "Updating",
      null,
      { timeout: 5000 }
    );
    await button.click({ force: true }).catch(() => {});

    assert.equal(await button.isDisabled(), true, "the in-flight button must be disabled");
    assert.equal(posts.length, 1, "a double click must not issue a second update request");
  } finally {
    await browser.close();
  }
});

test("SC-button-success-state: a successful update reports itself and refreshes", { skip }, async () => {
  // Oracle: button reads "Updated" and is disabled, a "Branch updated" toast
  // names the PR, and a follow-up scan was requested.
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ behind: [behindPr()] }), statusFixture({ behind: [], pass: [behindPr({ behindBy: 0 })] })]
  });
  try {
    await selectBehindView(page);
    await page.locator(".update-button").first().click();
    await page.waitForFunction(
      () => document.body.textContent?.includes("Branch updated"),
      null,
      { timeout: 5000 }
    );
    const toast = await page.locator(".toast").first().textContent();
    assert.match(toast, /Branch updated/, "a successful update must announce itself");
    assert.match(toast, /#118/, "the toast must name the PR it updated");
  } finally {
    await browser.close();
  }
});

// --- REQ-update-failure ------------------------------------------------------

test("SC-failure-403-message: a 403 shows GitHub's message and re-enables the button", { skip }, async () => {
  // Oracle: toast and #errorPanel both carry GitHub's message verbatim; the
  // button is enabled and reads "Update branch".
  const message = "refusing to allow a GitHub App to update this branch";
  const { browser, page } = await openDashboard({
    updateBranch: { status: 403, body: { error: message } }
  });
  try {
    await selectBehindView(page);
    await page.locator(".update-button").first().click();
    await page.waitForFunction(
      (text) => document.body.textContent?.includes(text),
      message,
      { timeout: 5000 }
    );

    const panel = await page.locator("#errorPanel").textContent();
    assert.match(panel, new RegExp(message), "the error panel must carry GitHub's own words, not a paraphrase");

    const button = page.locator(".update-button").first();
    assert.equal(await button.isDisabled(), false, "a failed update must leave the button usable");
    assert.match((await button.textContent()).trim(), /Update branch/, "the button must return to its ready label");
  } finally {
    await browser.close();
  }
});

test("SC-failure-row-survives: a failed update removes nothing from the lane", { skip }, async () => {
  // Oracle: 3 rows still present, navBehind still "3", no success toast
  const behind = [118, 119, 120].map((number) => behindPr({ number }));
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ behind })],
    updateBranch: { status: 422, body: { error: "merge conflict" } }
  });
  try {
    await selectBehindView(page);
    await page.locator(".update-button").first().click();
    await page.waitForFunction(() => document.body.textContent?.includes("Update failed"), null, { timeout: 5000 });

    assert.equal(await page.locator("#content .row").count(), 3, "a failed update must remove no row");
    assert.equal(await railCount(page, "navBehind"), "3", "the rail count must not drop on failure");
    assert.ok(
      !(await page.locator("body").textContent()).includes("Branch updated"),
      "a failure must never show the success toast"
    );
  } finally {
    await browser.close();
  }
});

test("SC-failure-transport-recovers: a network-level failure never leaves the button stuck", { skip }, async () => {
  // Oracle: an "Update failed" toast exists and the button is not disabled
  const { browser, page } = await openDashboard({ updateBranch: "abort" });
  try {
    await selectBehindView(page);
    await page.locator(".update-button").first().click();
    await page.waitForFunction(() => document.body.textContent?.includes("Update failed"), null, { timeout: 5000 });
    assert.equal(
      await page.locator(".update-button").first().isDisabled(),
      false,
      "the finally branch must clear the in-flight state even when the fetch itself rejects"
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-behind-notification -------------------------------------------------

test("SC-notify-stuck-only: a passing, non-draft, non-conflicting newly behind PR notifies once", { skip }, async () => {
  // Oracle: one popup titled "Branch out of date" tagged behind:<prKey>
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ pass: [behindPr({ behindBy: 0 })] }), statusFixture({ behind: [behindPr()] })]
  });
  try {
    await page.evaluate(() => document.querySelector("#refresh")?.click());
    await page.waitForFunction(() => document.body.textContent?.includes("Branch out of date"), null, { timeout: 5000 });
    const inbox = await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]"));
    const entries = inbox.filter((item) => String(item.tag || "").startsWith("behind:"));
    assert.equal(entries.length, 1, "a PR stuck only on the update must announce itself exactly once");
  } finally {
    await browser.close();
  }
});

test("SC-notify-suppressed-when-other-blockers: failing, running, draft and no-CI PRs entering the lane stay silent", { skip }, async () => {
  // Oracle: sendPopup produced 0 entries. Being behind is not that PR's blocker.
  const noisy = [
    behindPr({ number: 301, state: "fail" }),
    behindPr({ number: 302, state: "running" }),
    behindPr({ number: 303, isDraft: true }),
    behindPr({ number: 304, checkCount: 0 })
  ];
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ behind: [] }), statusFixture({ behind: noisy })]
  });
  try {
    await page.evaluate(() => document.querySelector("#refresh")?.click());
    await page.waitForFunction(() => document.querySelector("#navBehind")?.textContent === "4", null, { timeout: 5000 });
    const inbox = await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]"));
    assert.equal(
      inbox.filter((item) => String(item.tag || "").startsWith("behind:")).length,
      0,
      "only a PR blocked solely by being behind may notify (DL-008)"
    );
  } finally {
    await browser.close();
  }
});

test("SC-notify-no-repeat: a PR already in the lane does not re-notify on the next scan", { skip }, async () => {
  // Oracle: 0 additional popups for a PR present in both snapshots
  const stuck = behindPr();
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ pass: [behindPr({ behindBy: 0 })] }), statusFixture({ behind: [stuck] })]
  });
  try {
    await page.evaluate(() => document.querySelector("#refresh")?.click());
    await page.waitForFunction(() => document.body.textContent?.includes("Branch out of date"), null, { timeout: 5000 });
    await page.evaluate(() => document.querySelector("#refresh")?.click());
    await page.waitForTimeout(500);
    const inbox = await page.evaluate(() => JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]"));
    assert.equal(
      inbox.filter((item) => String(item.tag || "").startsWith("behind:")).length,
      1,
      "the wasNotified guard must stop a still-behind PR re-announcing on every scan"
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-behind-pill ---------------------------------------------------------

test("SC-pill-plural-copy: the pill shows the count and the base branch", { skip }, async () => {
  // Oracle: normalized pill text "12 BEHIND MAIN"; title starts "12 commits behind main"
  const { browser, page } = await openDashboard();
  try {
    await selectBehindView(page);
    const pill = page.locator(".behind-pill").first();
    assert.equal(await pill.count(), 1, "the row must carry a behind pill");

    const text = (await pill.textContent()).replace(/\s+/g, " ").trim().toUpperCase();
    assert.equal(text, "12 BEHIND MAIN", "the pill states how far behind, and behind what");
    assert.match(
      await pill.getAttribute("title"),
      /^12 commits behind main/,
      "the full sentence lives in the title, where it does not crowd the other pills"
    );
  } finally {
    await browser.close();
  }
});

test("SC-pill-singular-copy: a single commit behind reads in the singular", { skip }, async () => {
  // Oracle: title starts "1 commit behind main" and never says "1 commits"
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ behind: [behindPr({ behindBy: 1 })] })]
  });
  try {
    await selectBehindView(page);
    const title = await page.locator(".behind-pill").first().getAttribute("title");
    assert.match(title, /^1 commit behind main/, "one commit is singular");
    assert.ok(!title.includes("1 commits"), "never '1 commits'");
  } finally {
    await browser.close();
  }
});

test("SC-pill-long-branch-no-overflow: a long base branch name truncates instead of overflowing the row", { skip }, async () => {
  // Oracle: no horizontal page scroll at 1280px, full name still in the title,
  // and the ref span is actually clipped.
  const baseRefName = "release/2026-09-hotfix-candidate";
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ behind: [behindPr({ baseRefName })] })]
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await selectBehindView(page);

    assert.match(
      await page.locator(".behind-pill").first().getAttribute("title"),
      new RegExp(baseRefName),
      "the untruncated branch name must remain available in the title"
    );
    const clipped = await page.evaluate(() => {
      const ref = document.querySelector(".behind-pill-ref");
      return ref ? ref.scrollWidth > ref.clientWidth : null;
    });
    assert.equal(clipped, true, "a long base ref must be clipped by the pill, not allowed to stretch it");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollWidth <= 1280, `the page must not scroll horizontally at 1280px (was ${scrollWidth})`);
  } finally {
    await browser.close();
  }
});

// --- REQ-lane-actions --------------------------------------------------------

test("SC-actions-merge-available: a mergeable behind PR keeps an enabled Merge button", { skip }, async () => {
  // Oracle: .merge-button exists in the row and is not disabled
  const { browser, page } = await openDashboard();
  try {
    await selectBehindView(page);
    const merge = page.locator("#content .row .merge-button").first();
    assert.equal(await merge.count(), 1, "moving a PR into this lane must not cost it the Merge button (DL-006)");
    assert.equal(await merge.isDisabled(), false, "a passing, non-draft, non-conflicting PR stays mergeable");
  } finally {
    await browser.close();
  }
});

test("SC-actions-merge-blocked-reason: a non-mergeable behind PR disables Merge and states why", { skip }, async () => {
  // Oracle: merge button disabled with title "Draft pull requests cannot be merged"
  const { browser, page } = await openDashboard({
    statuses: [statusFixture({ behind: [behindPr({ isDraft: true })] })]
  });
  try {
    await selectBehindView(page);
    const merge = page.locator("#content .row .merge-button").first();
    assert.equal(await merge.isDisabled(), true, "a draft must not be mergeable from this lane either");
    assert.equal(
      await merge.getAttribute("title"),
      "Draft pull requests cannot be merged",
      "the existing mergeBlockReason gate must still supply the reason"
    );
  } finally {
    await browser.close();
  }
});

test("SC-actions-one-filled-primary: exactly one filled button per row, and it is Update branch", { skip }, async () => {
  // Oracle: exactly 1 button in .row-actions has a background-color with alpha > 0,
  // and it carries the update-button class. Three filled primaries in one row is
  // a hierarchy no other lane in this dashboard has.
  const { browser, page } = await openDashboard({
    statuses: [
      statusFixture({
        behind: [behindPr({ state: "fail", failedRuns: [{ runId: 101, workflow: "CI" }] })]
      })
    ]
  });
  try {
    await selectBehindView(page);
    const filled = await page.evaluate(() => {
      const actions = document.querySelector("#content .row .row-actions");
      if (!actions) return null;
      return [...actions.querySelectorAll("button")]
        .filter((el) => {
          const bg = getComputedStyle(el).backgroundColor;
          const match = /rgba?\(([^)]+)\)/.exec(bg);
          if (!match) return false;
          const parts = match[1].split(",").map((n) => parseFloat(n));
          return parts.length < 4 || parts[3] > 0;
        })
        .map((el) => el.className.trim());
    });
    assert.ok(filled, "the row must render an action group");
    assert.equal(
      filled.length,
      1,
      `exactly one filled button per row is the invariant every other lane holds; found ${filled.length}: ${filled.join(", ")}`
    );
    assert.match(filled[0], /update-button/, "the single filled button must be the lane's primary action");
  } finally {
    await browser.close();
  }
});

// --- REQ-empty-state ---------------------------------------------------------

test("SC-empty-state-copy: the empty lane explains itself", { skip }, async () => {
  // Oracle: the empty sentence is present and 0 rows render
  const { browser, page } = await openDashboard({ statuses: [statusFixture({ behind: [] })] });
  try {
    await selectBehindView(page);
    assert.equal(await page.locator("#content .row").count(), 0, "an empty lane renders no rows");
    assert.match(
      await page.locator("#content").textContent(),
      /No PRs waiting on a branch update\./,
      "the empty state must say what would appear here"
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-axe -----------------------------------------------------------------

test("SC-axe-clean-both-themes: the new view is axe-clean in dark and light", { skip }, async () => {
  // Oracle: violations.length === 0 for both themes.
  //
  // This is the repo's first axe assertion: axe-core has been a declared but
  // unused devDependency, so there was no existing accessibility pass to inherit.
  for (const theme of ["dark", "light"]) {
    const { browser, page } = await openDashboard({ theme });
    try {
      await selectBehindView(page);
      await page.waitForSelector("#content .row");
      await page.addScriptTag({ content: axeJs });
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run("#content", {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] }
        });
        return result.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
      });
      assert.deepEqual(violations, [], `${theme} theme must report no axe violations, got: ${violations.join("; ")}`);
    } finally {
      await browser.close();
    }
  }
});
