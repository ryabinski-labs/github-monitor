// The row action group is a design system: OPEN PR, MERGE, CLOSE, RERUN and
// UPDATE BRANCH are one family of controls that must be indistinguishable apart
// from their colour role.
//
// This file exists because that was not true and nothing noticed. `.update-button`
// was never added to the shared base rule in public/styles.css, so it rendered at
// the browser's user-agent defaults -- 16px/400/sentence-case/square -- next to
// three 10.5px/700/uppercase/6px-radius siblings, in every release since the lane
// shipped. Every existing test asked whether the button was *there*, what it said,
// and whether it was disabled. None asked whether it looked like the product.
//
// The oracle is deliberately relative: it asserts the family agrees with itself,
// never that it equals a hardcoded 10.5px. A restyle of the whole group stays
// green; one member drifting out of the group goes red. That is the failure mode
// worth catching, and hardcoding the values would instead pin this file to a
// design decision it has no business owning.
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
const asset = {
  "/index.html": ["text/html", readFileSync(path.join(root, "public/index.html"), "utf8")],
  "/app.js": ["text/javascript", readFileSync(path.join(root, "public/app.js"), "utf8")],
  "/theme.js": ["text/javascript", readFileSync(path.join(root, "public/theme.js"), "utf8")],
  "/styles.css": ["text/css", readFileSync(path.join(root, "public/styles.css"), "utf8")]
};

// The five members of the family. `.row-dismiss` deliberately sits outside it:
// it is a tertiary text action with its own 30px/sentence-case treatment.
const FAMILY = ["open-link", "merge-button", "close-button", "rerun-button", "update-button"];
const OUTSIDE_FAMILY = ["row-dismiss", "row-dismiss-auto"];

// Everything a reader would call "the same kind of button". Colour is excluded on
// purpose -- the colour role is what legitimately differs between members.
const SHARED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "textTransform",
  "borderRadius",
  "borderWidth",
  "borderStyle",
  "minHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "display"
];

function pr(overrides = {}) {
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
    behindBy: 0,
    runningChecks: [],
    ...overrides
  };
}

// One fixture that lights up all four lanes that render row actions, so the sweep
// below does not depend on a list of lanes kept in sync by hand.
function everyLane() {
  const behind = [pr({ number: 118, behindBy: 12 })];
  const pass = [pr({ number: 201 })];
  const fail = [pr({ number: 301, state: "fail", failedRuns: [{ runId: 9001, workflow: "CI" }] })];
  const conflicts = [pr({ number: 401, hasConflict: true, mergeable: "CONFLICTING" })];
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
      failingPrs: fail.length,
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
    pullRequests: { pass, noCi: [], fail, running: [], conflicts, behind },
    actions: { failed: [], running: [] },
    cd: { running: [], failed: [], finished: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

// 1440x900 rather than Playwright's 1280x720: below ~1366 the row grid stacks and
// the action group gets a full-width line of its own, which hides any width
// pressure the wide layout actually applies.
async function openDashboard(theme = "dark") {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((storedTheme) => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "behind", theme: storedTheme }));
    localStorage.removeItem("pr-deck:dismissed:v1");
    localStorage.removeItem("pr-deck:inbox:v1");
  }, theme);
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const key = pathname === "/" ? "/index.html" : pathname;
    if (asset[key]) return route.fulfill({ contentType: asset[key][0], body: asset[key][1] });
    if (pathname === "/api/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(everyLane()) });
    }
    if (pathname === "/api/pull-request/update-branch") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ updated: true }) });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForSelector("#rail");
  return { browser, page };
}

// Walks every lane that renders row actions and returns one record per control.
async function sweepLanes(page, family, outside) {
  const views = await page.evaluate(() =>
    [...document.querySelectorAll(".rail-item")].map((el) => el.dataset.view).filter(Boolean)
  );
  const seen = [];
  for (const view of views) {
    await page.locator(`.rail-item[data-view="${view}"]`).click();
    await page.waitForFunction(() => !document.querySelector("#content [data-rendering]"), null, { timeout: 5000 })
      .catch(() => {});
    const found = await page.evaluate(
      ({ props, familyClasses, outsideClasses, lane }) => {
        const records = [];
        for (const el of document.querySelectorAll("#content .row-actions button, #content .row-actions a")) {
          const classes = [...el.classList];
          if (classes.some((c) => outsideClasses.includes(c))) continue;
          const member = classes.find((c) => familyClasses.includes(c)) || null;
          const cs = getComputedStyle(el);
          const style = {};
          for (const p of props) style[p] = cs[p];
          records.push({ lane, member, classes: classes.join(" "), label: el.textContent.trim(), style });
        }
        return records;
      },
      { props: SHARED, familyClasses: family, outsideClasses: outside, lane: view }
    );
    seen.push(...found);
  }
  return seen;
}

function signature(style) {
  return SHARED.map((p) => `${p}=${style[p]}`).join(" | ");
}

for (const theme of ["dark", "light"]) {
  test(`row actions are one visual family in the ${theme} theme`, { skip }, async () => {
    // Oracle: across every lane, every control in .row-actions that is not the
    // tertiary Dismiss action resolves to a byte-identical tuple of SHARED
    // properties. Pre-fix, .update-button differed on 7 of the 14 at once.
    const { browser, page } = await openDashboard(theme);
    try {
      const controls = await sweepLanes(page, FAMILY, OUTSIDE_FAMILY);

      assert.ok(
        controls.length >= FAMILY.length,
        `the sweep must reach every family member; found ${controls.length} controls`
      );
      const members = new Set(controls.map((c) => c.member));
      for (const expected of FAMILY) {
        assert.ok(
          members.has(expected),
          `.${expected} never rendered, so this run proves nothing about it — fix the fixture, not the assertion`
        );
      }

      // Any control that reached .row-actions without joining the family is the
      // exact bug this file was written for, one class name later.
      const unclassified = controls.filter((c) => !c.member);
      assert.deepEqual(
        unclassified.map((c) => c.classes),
        [],
        "a row action that belongs to no known family member cannot be held to the shared style; add it to the base rule in public/styles.css and to FAMILY here"
      );

      const groups = new Map();
      for (const c of controls) {
        const key = signature(c.style);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(`${c.member} ("${c.label}", ${c.lane} lane)`);
      }
      assert.equal(
        groups.size,
        1,
        `every row action must share one geometry and one type treatment; found ${groups.size} distinct styles:\n` +
          [...groups].map(([sig, who]) => `  ${who.join(", ")}\n    ${sig}`).join("\n")
      );
    } finally {
      await browser.close();
    }
  });
}

test("a completed row action keeps the family style while disabled", { skip }, async () => {
  // Oracle: after Update branch -> Updated, the disabled button still matches its
  // siblings on every SHARED property. This is the state the regression was
  // actually reported in: a finished action sitting in a row of unfinished ones.
  const { browser, page } = await openDashboard("dark");
  try {
    await page.locator('.rail-item[data-view="behind"]').click();
    await page.locator(".update-button").first().click();
    await page.waitForFunction(
      () => document.querySelector(".update-button")?.textContent?.trim() === "Updated",
      null,
      { timeout: 5000 }
    );

    const row = await page.evaluate(
      ({ props, outsideClasses }) => {
        const out = [];
        for (const el of document.querySelectorAll("#content .row-actions button, #content .row-actions a")) {
          if ([...el.classList].some((c) => outsideClasses.includes(c))) continue;
          const cs = getComputedStyle(el);
          const style = {};
          for (const p of props) style[p] = cs[p];
          out.push({ label: el.textContent.trim(), disabled: el.disabled === true, style });
        }
        return out;
      },
      { props: SHARED, outsideClasses: OUTSIDE_FAMILY }
    );

    const done = row.find((c) => c.label === "Updated");
    assert.ok(done, "the behind lane must reach the Updated state for this assertion to mean anything");
    assert.equal(done.disabled, true, "the completed action must be disabled — otherwise this is not the state under test");

    for (const sibling of row.filter((c) => c !== done)) {
      assert.equal(
        signature(done.style),
        signature(sibling.style),
        `"Updated" must stay in the family while disabled, but it differs from "${sibling.label}"`
      );
    }
  } finally {
    await browser.close();
  }
});
