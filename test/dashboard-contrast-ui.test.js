// Red-phase browser coverage for the dashboard's contrast debt.
//
// Derived from docs/prd/dashboard-contrast.md via tdd/dashboard-contrast.tdd.yaml.
// Scenario IDs appear verbatim in test names and are the join key to the
// artifact and to QA results — never rename them.
//
// Two kinds of test live here, and the difference matters. The first four
// measure the page directly and fail on the real defect; their oracle is
// deliberately independent of the gate, because an acceptance test that borrows
// the implementation's own judgement cannot catch the implementation being
// wrong. The rest exercise the gate itself and fail, for now, because it does
// not exist.
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

async function loadGate() {
  try {
    return await import("./support/contrast-gate.js");
  } catch {
    return null;
  }
}

// --- fixtures ----------------------------------------------------------------

function pr(repo, number, overrides = {}) {
  return {
    repo,
    number,
    numberLabel: `#${number}`,
    title: "feat(console): hand out an immutable chart tag when this is a release build",
    author: "cigan1",
    url: `https://github.com/${repo}/pull/${number}`,
    state: "pass",
    checkCount: 4,
    isDraft: false,
    hasConflict: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    runningChecks: [],
    ...overrides
  };
}

const LANES = ["pass", "fail", "conflicts", "behind", "running"];

// Three rows per lane, not one. A lane with a single row cannot express the
// scenario that matters most here — a dismissed row sitting beside a live one —
// and dismissing the only row leaves nothing to compare it against.
function statusFixture() {
  const pass = [pr("ryabinski-labs/waf", 101), pr("ryabinski-labs/siftfy", 111), pr("ryabinski-labs/gipsychef", 121)];
  const fail = [102, 112, 122].map((number, index) =>
    pr(["ryabinski-labs/fieldwatt", "ryabinski-labs/waf", "ryabinski-labs/primecam"][index], number, {
      state: "fail",
      failureReason: "CI/test failed"
    })
  );
  const conflicts = [pr("ryabinski-labs/primecam", 103, { hasConflict: true, mergeable: "CONFLICTING" })];
  const behind = [pr("ryabinski-labs/yearclose", 104, { behindBy: 9 }), pr("ryabinski-labs/webemail", 114, { behindBy: 3 })];
  const running = [
    pr("ryabinski-labs/webemail", 105, {
      state: "running",
      runningChecks: [{ name: "CI", startedAt: "2026-09-18T11:00:00Z" }]
    })
  ];
  return {
    account: "ryabinski-labs",
    accounts: ["ryabinski-labs"],
    generatedAt: "2026-09-18T12:45:00Z",
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 5,
      passingPrs: 3,
      noCiPrs: 0,
      failingPrs: 3,
      conflictPrs: 1,
      behindPrs: 2,
      runningPrs: 1,
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
    pullRequests: { pass, noCi: [], fail, running, conflicts, behind },
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

// 1440x900 and not the default: at 1280x720 axe returns every colour-contrast
// node as `incomplete` ("pseudoContent" — the row's ::before bar defeats its
// background resolution), and the same page at 1440 yields nine real
// violations. PRD §8 R-001; A-004 pins the number.
async function openDashboard({ theme = "dark", view = "fail" } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const status = statusFixture();

  await page.addInitScript(
    ([storedView, storedTheme]) => {
      localStorage.setItem("pr-deck:v1", JSON.stringify({ view: storedView, theme: storedTheme }));
      localStorage.removeItem("pr-deck:dismissed:v1");
      localStorage.removeItem("pr-deck:notified:v1");
      localStorage.removeItem("pr-deck:inbox:v1");
      localStorage.removeItem("pr-deck:repo-colours:v1");
    },
    [view, theme]
  );

  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: asset("public/index.html") });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: asset("public/app.js") });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: asset("public/theme.js") });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: asset("public/styles.css") });
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(status) });
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector(".row");
  await settle(page);
  return { browser, page };
}

// The resting page is the only page worth measuring. `.metric-group` carries a
// staggered entrance fade (public/styles.css, delays 30/100/170/240 ms), and
// four of the five "failures" in the spec's own source evidence were that fade
// caught mid-flight. PRD §8 R-002.
async function settle(page) {
  await page
    .waitForFunction(
      () => document.getAnimations().every((animation) => animation.playState === "finished" || animation.playState === "idle"),
      null,
      { timeout: 8000 }
    )
    .catch(() => {});
  await page.waitForTimeout(150);
}

async function dismissAndReveal(page, count = 1) {
  for (let index = 0; index < count; index += 1) {
    const button = page.locator('.row-dismiss[data-dismiss-action="dismiss"]').first();
    if (!(await button.count())) break;
    await button.click();
    await page.waitForTimeout(150);
  }
  const show = page.locator('button:has-text("Show")').first();
  if (await show.count()) await show.click().catch(() => {});
  await settle(page);
  return page.locator(".row-dismissed").count();
}

// An oracle the gate does not get a vote in. Roughly twenty-five lines of what
// the gate will also do, kept separate on purpose: an acceptance test that asks
// the implementation whether the implementation is right proves nothing.
// An oracle the gate does not get a vote in. Roughly the same work the gate will
// also do, kept separate on purpose: an acceptance test that asks the
// implementation whether the implementation is right proves nothing.
//
// Plain functions rather than source strings, because page.evaluate treats a
// string as an expression and never applies the argument — which is how the
// first draft of this file reported `undefined` for every probe.
function measureInPage(selector) {
  const parse = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number(part.trim()));
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, bottom, alpha) => top.map((channel, index) => channel * alpha + bottom[index] * (1 - alpha));
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const backgroundOf = (element) => {
    const layers = [];
    let node = element;
    while (node) {
      const parsed = parse(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.alpha > 0) layers.push(parsed);
      node = node.parentElement;
    }
    let stack = [255, 255, 255];
    for (let index = layers.length - 1; index >= 0; index -= 1) stack = over(layers[index].rgb, stack, layers[index].alpha);
    return stack;
  };
  const effectiveAlpha = (element) => {
    let node = element;
    let alpha = 1;
    while (node && node !== document.documentElement) {
      alpha *= Number(getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return alpha;
  };
  const results = [];
  for (const element of document.querySelectorAll(`${selector} *`)) {
    const hasOwnText = [...element.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim());
    if (!hasOwnText) continue;
    if (element.closest("[disabled]")) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const foreground = parse(style.color);
    if (!foreground) continue;
    const background = backgroundOf(element);
    const composited = over(foreground.rgb, background, foreground.alpha * effectiveAlpha(element));
    results.push({
      selector: element.className ? `.${String(element.className).split(" ").filter(Boolean).join(".")}` : element.tagName.toLowerCase(),
      text: element.textContent.trim().slice(0, 30),
      ratio: Math.round(ratio(composited, background) * 100) / 100
    });
  }
  return results;
}

// Peak saturation over a row's own colours and its descendants'. Greyscale
// pins this to 0; any accent colour pushes it above 0.
function saturationInPage(selector) {
  const parse = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number(part.trim()));
    if (parts.length > 3 && parts[3] === 0) return null;
    return parts.slice(0, 3);
  };
  const saturation = (rgb) => (Math.max(...rgb) - Math.min(...rgb)) / 255;
  const root = document.querySelector(selector);
  if (!root) return null;
  let peak = 0;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const style = getComputedStyle(element);
    for (const value of [style.color, style.backgroundColor, style.borderTopColor, style.borderLeftColor]) {
      const rgb = parse(value);
      if (rgb) peak = Math.max(peak, saturation(rgb));
    }
    const before = getComputedStyle(element, "::before");
    const beforeRgb = parse(before.backgroundColor);
    if (beforeRgb && before.content !== "none") peak = Math.max(peak, saturation(beforeRgb));
  }
  return Math.round(peak * 1000) / 1000;
}

// --- REQ-001 -----------------------------------------------------------------

test("SC-dismissed-contrast-both-themes: a revealed dismissed row is as readable as a live one", { skip }, async () => {
  // Oracle: for each theme, min(contrast of every text node under .row-dismissed) >= 4.5
  //
  // Both themes in one test because it is one requirement — but the message
  // names the theme, because issue #126's ladder was measured in dark alone and
  // concluded 0.90 clears AA, while light still failed at 4.04:1.
  for (const theme of ["dark", "light"]) {
    const { browser, page } = await openDashboard({ theme });
    try {
      const revealed = await dismissAndReveal(page);
      assert.ok(revealed > 0, `${theme}: the fixture must actually produce a revealed dismissed row, or this test proves nothing`);

      const nodes = await page.evaluate(measureInPage, ".row-dismissed");
      assert.ok(nodes.length > 0, `${theme}: a dismissed row must contain measurable text`);

      const worst = nodes.reduce((low, node) => (node.ratio < low.ratio ? node : low));
      assert.ok(
        worst.ratio >= 4.5,
        `${theme} theme: "${worst.text}" (${worst.selector}) in a revealed dismissed row measures ${worst.ratio}:1; WCAG 2.2 AA needs 4.5:1. A row that is set aside is still a row you chose to look at again.`
      );
    } finally {
      await browser.close();
    }
  }
});

// --- REQ-002 -----------------------------------------------------------------

test("SC-dismissed-greyscale: a dismissed row carries no accent colour while a live row keeps its own", { skip }, async () => {
  // Oracle: max saturation over the dismissed row's sampled colours === 0, and > 0 for the live row
  const { browser, page } = await openDashboard({ theme: "dark" });
  try {
    const revealed = await dismissAndReveal(page, 1);
    assert.ok(revealed > 0, "the fixture must produce a revealed dismissed row");

    const dismissed = await page.evaluate(saturationInPage, ".row-dismissed");
    const live = await page.evaluate(saturationInPage, ".row:not(.row-dismissed)");

    assert.ok(live !== null && live > 0, "a live row must keep colour, or the comparison is meaningless");
    assert.equal(
      dismissed,
      0,
      `a dismissed row must lose all of its colour — accent bar, status pill, repo name and buttons — and measured ${dismissed} saturation instead. Contrast alone cannot express this: opacity 1.0 with no filter would satisfy REQ-001 and leave no affordance at all.`
    );
  } finally {
    await browser.close();
  }
});

test("SC-dismissed-hover-restores-colour: hovering a dismissed row brings its colour back", { skip }, async () => {
  // Oracle: max saturation > 0 while hovered, === 0 when not
  const { browser, page } = await openDashboard({ theme: "dark" });
  try {
    const revealed = await dismissAndReveal(page, 1);
    assert.ok(revealed > 0, "the fixture must produce a revealed dismissed row");

    const resting = await page.evaluate(saturationInPage, ".row-dismissed");
    await page.locator(".row-dismissed").first().hover();
    await page.waitForTimeout(250);
    const hovered = await page.evaluate(saturationInPage, ".row-dismissed");

    assert.equal(resting, 0, `at rest a dismissed row must be colourless, measured ${resting}`);
    assert.ok(
      hovered > 0,
      `hovering must bring the colour back, as .row-dismissed:hover does today, and measured ${hovered}`
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-003 -----------------------------------------------------------------

test("SC-amber-tag-both-themes: the amber pill is readable in both themes", { skip }, async () => {
  // Oracle: contrast(.tag colour, .tag background) >= 4.5 in both themes
  //
  // The oracle names no token on purpose. A-005 expects --amber-on-soft, which
  // already exists and measures 5.29:1, but any colour that clears 4.5:1
  // satisfies the requirement — asserting the token would be asserting an
  // internal a refactor is entitled to change.
  for (const theme of ["dark", "light"]) {
    const { browser, page } = await openDashboard({ theme, view: "behind" });
    try {
      await settle(page);
      const tags = await page.evaluate(measureInPage, ".row .tag-group");
      const amber = tags.filter((node) => node.selector.includes("tag"));
      assert.ok(amber.length > 0, `${theme}: the behind lane must render a status pill to measure`);

      const worst = amber.reduce((low, node) => (node.ratio < low.ratio ? node : low));
      assert.ok(
        worst.ratio >= 4.5,
        `${theme} theme: the amber pill "${worst.text}" measures ${worst.ratio}:1; WCAG 2.2 AA needs 4.5:1. The lane the dashboard is pointing at should not be the hardest one to read.`
      );
    } finally {
      await browser.close();
    }
  }
});

// --- REQ-004 -----------------------------------------------------------------

test("SC-gate-finds-unlisted-surface: a failing colour on a surface nothing enumerates is still reported", { skip }, async () => {
  // Oracle: the findings include the injected node, with a ratio within 0.05 of the computed pair
  const gate = await loadGate();
  assert.ok(
    gate && typeof gate.runContrastGate === "function",
    "test/support/contrast-gate.js must export runContrastGate(page, options); this is the scenario that separates DL-004's answer from the two it beat — a token table and a combinatorial sweep both pass every other gate check and fail this one"
  );

  const { browser, page } = await openDashboard();
  try {
    await page.evaluate(() => {
      const host = document.querySelector(".row");
      const probe = document.createElement("span");
      probe.className = "unlisted-probe";
      probe.textContent = "nothing enumerates this";
      probe.style.color = "#8a8a8a";
      probe.style.backgroundColor = "#7a7a7a";
      host.appendChild(probe);
    });

    const result = await gate.runContrastGate(page, { lanes: LANES, themes: ["dark"] });
    const finding = result.findings.find((entry) => entry.selector.includes("unlisted-probe"));
    assert.ok(finding, "a node no list mentions must still be measured — coverage comes from the page, not from an enumeration someone maintains");
    assert.ok(Math.abs(finding.ratio - 1.15) < 0.05, `#8a8a8a on #7a7a7a is 1.15:1; the gate reported ${finding.ratio}`);
  } finally {
    await browser.close();
  }
});

test("SC-gate-visits-every-lane-and-theme: coverage cannot shrink and still look like a pass", { skip }, async () => {
  // Oracle: summary.surfaceStates >= 30, and the gate fails when it is lower
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard();
  try {
    const result = await gate.runContrastGate(page, { lanes: LANES, themes: ["dark", "light"] });
    assert.ok(
      result.summary.surfaceStates >= 30,
      `5 lanes x 2 themes x 3 states is 30 surface-states (PRD §13); the gate visited ${result.summary.surfaceStates}. Without this floor, deleting a lane from the matrix turns a red gate green.`
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-005 -----------------------------------------------------------------

test("SC-gate-reports-composited-failure: text dimmed by an ancestor's opacity is reported at its composited ratio", { skip }, async () => {
  // Oracle: the finding's ratio is the composited one, not the token one, within 0.05
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard();
  try {
    const expected = await page.evaluate(() => {
      const host = document.querySelector(".row");
      const wrapper = document.createElement("div");
      wrapper.style.opacity = "0.4";
      wrapper.style.backgroundColor = "#ffffff";
      const probe = document.createElement("span");
      probe.className = "composited-probe";
      probe.textContent = "dimmed by an ancestor";
      probe.style.color = "#000000";
      wrapper.appendChild(probe);
      host.appendChild(wrapper);
      // Black at 0.4 over white is #999999, which is 2.85:1 on white — where the
      // token value alone would claim 21:1.
      return 2.85;
    });

    const result = await gate.runContrastGate(page, { lanes: LANES, themes: ["dark"] });
    const finding = result.findings.find((entry) => entry.selector.includes("composited-probe"));
    assert.ok(finding, "issue #126 reduced to one check: a gate that reads stylesheet tokens reports nothing here");
    assert.ok(
      Math.abs(finding.ratio - expected) < 0.05,
      `the gate must report the composited ratio (${expected}:1), not the token's 21:1; it reported ${finding.ratio}`
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-006 -----------------------------------------------------------------

test("SC-gate-waits-for-animations: a staggered entrance fade is not reported as a contrast failure", { skip }, async () => {
  // Oracle: no .metric-label finding, and every animation finished before the first measurement
  //
  // R-002 in full. Four of the five failures in this spec's own source evidence
  // were this animation caught mid-flight. A gate that opens with a list of
  // defects that do not exist gets switched off in a week.
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard({ theme: "light" });
  try {
    await page.reload();
    await page.waitForSelector(".metric-label");
    // Deliberately no settle() here: the gate is the thing that must wait.
    const result = await gate.runContrastGate(page, { lanes: ["pass"], themes: ["light"] });
    const strays = result.findings.filter((entry) => entry.selector.includes("metric-label"));
    assert.deepEqual(
      strays,
      [],
      `.metric-label rests at --muted-strong, 6.39:1 — any finding here is the entrance fade being measured mid-flight, not a defect: ${JSON.stringify(strays)}`
    );
  } finally {
    await browser.close();
  }
});

test("SC-gate-animation-ceiling: an animation that never settles fails the gate loudly rather than hanging", { skip }, async () => {
  // Oracle: fails within 8s +/- 1s, and the message names the unsettled animation
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard();
  try {
    await page.addStyleTag({
      content: "@keyframes never-settles { from { opacity: 0.4 } to { opacity: 0.6 } } .row { animation: never-settles 1s infinite; }"
    });

    const started = Date.now();
    let message = "";
    try {
      await gate.runContrastGate(page, { lanes: ["fail"], themes: ["dark"] });
      assert.fail("an animation that never settles must fail the gate, not be measured mid-flight");
    } catch (error) {
      message = String(error?.message || error);
    }
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 7000 && elapsed <= 9000, `the gate must give up at the 8s ceiling (PRD §13); it took ${elapsed}ms`);
    assert.match(message, /never-settles/, `the failure must name the animation that did not settle, got: ${message}`);
  } finally {
    await browser.close();
  }
});

// --- REQ-007 -----------------------------------------------------------------

test("SC-gate-skips-disabled: a disabled button below 4.5:1 is not a finding", { skip }, async () => {
  // Oracle: no finding whose element matches [disabled]
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard();
  try {
    const disabledCount = await page.evaluate(() => {
      const button = document.querySelector(".merge-button") || document.querySelector("button");
      if (!button) return 0;
      button.disabled = true;
      return 1;
    });
    assert.equal(disabledCount, 1, "the fixture must produce a disabled control to skip");

    const result = await gate.runContrastGate(page, { lanes: ["fail"], themes: ["dark"] });
    const disabledFindings = result.findings.filter((entry) => entry.disabled);
    assert.deepEqual(
      disabledFindings,
      [],
      `WCAG 2.2 exempts inactive components (A-007); .merge-button:disabled sits at opacity 0.72 and would otherwise fail: ${JSON.stringify(disabledFindings)}`
    );
  } finally {
    await browser.close();
  }
});

// --- REQ-008 -----------------------------------------------------------------

test("SC-gate-fails-on-unresolvable-background: could-not-decide is reported as a failure, not as a pass", { skip }, async () => {
  // Oracle: the gate fails, and its message names the node whose background could not be resolved
  //
  // R-001 turned into a standing check. Both pre-existing axe assertions read
  // only `violations` and ignored `incomplete`, and at the default viewport
  // every node landed in `incomplete` — so they asserted the absence of a list
  // axe never populated. This makes that shape of vacuity impossible here.
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard();
  try {
    await page.evaluate(() => {
      const host = document.querySelector(".row");
      const probe = document.createElement("span");
      probe.className = "unresolvable-probe";
      probe.textContent = "no resolvable background";
      probe.style.color = "#123456";
      probe.style.backgroundImage = "linear-gradient(90deg, #000 0%, #fff 100%)";
      probe.style.backgroundColor = "transparent";
      host.appendChild(probe);
    });

    let message = "";
    try {
      await gate.runContrastGate(page, { lanes: ["fail"], themes: ["dark"] });
      assert.fail("a background the gate cannot resolve must fail it; declining to look is not the same as finding nothing");
    } catch (error) {
      message = String(error?.message || error);
    }
    assert.match(message, /unresolvable-probe/, `the failure must name the node it could not resolve, got: ${message}`);
  } finally {
    await browser.close();
  }
});

// --- REQ-010 -----------------------------------------------------------------

test("SC-gate-message-fields: a failure line carries every field needed to act on it", { skip }, async () => {
  // Oracle: selector, two hex colours, a NN.NN:1 measured ratio, the literal 4.5:1, a theme, a lane
  const gate = await loadGate();
  assert.ok(
    gate && typeof gate.runContrastGate === "function" && typeof gate.formatFinding === "function",
    "test/support/contrast-gate.js must export runContrastGate(page, options) and formatFinding(finding)"
  );

  const { browser, page } = await openDashboard();
  try {
    await page.evaluate(() => {
      const host = document.querySelector(".row");
      const probe = document.createElement("span");
      probe.className = "message-probe";
      probe.textContent = "too quiet to read";
      probe.style.color = "#8a8a8a";
      probe.style.backgroundColor = "#7a7a7a";
      host.appendChild(probe);
    });

    const result = await gate.runContrastGate(page, { lanes: ["fail"], themes: ["dark"] });
    const finding = result.findings.find((entry) => entry.selector.includes("message-probe"));
    assert.ok(finding, "the probe must be found before its message can be judged");

    const line = gate.formatFinding(finding);
    assert.match(line, /message-probe/, "the line must name the selector");
    assert.match(line, /#8a8a8a/i, "the line must give the foreground as hex");
    assert.match(line, /#7a7a7a/i, "the line must give the background as hex");
    assert.match(line, /\d+\.\d{2}:1/, "the line must give the measured ratio to two decimals");
    assert.match(line, /4\.5:1/, "the line must state the required ratio");
    assert.match(line, /\b(dark|light)\b/, "the line must name the theme");
    assert.match(line, new RegExp(`\\b(${LANES.join("|")})\\b`), "the line must name the lane");
  } finally {
    await browser.close();
  }
});

// --- REQ-011 -----------------------------------------------------------------

test("SC-gate-runtime-budget: the gate stays inside its time budget", { skip }, async () => {
  // Oracle: the gate's reported wall-clock <= 60000 ms
  //
  // P1, and the number is A-003 — an admitted guess, because there was no gate
  // to measure when the spec was written. The PRD says the first real run
  // replaces the guess with the measurement; this test is where that shows up.
  const gate = await loadGate();
  assert.ok(gate && typeof gate.runContrastGate === "function", "test/support/contrast-gate.js must export runContrastGate(page, options)");

  const { browser, page } = await openDashboard();
  try {
    const result = await gate.runContrastGate(page, { lanes: LANES, themes: ["dark", "light"] });
    assert.ok(
      result.summary.wallClockMs <= 60000,
      `the gate took ${result.summary.wallClockMs}ms against a 60000ms budget (A-003). If this is the first real measurement, replace the assumption in the PRD with the number rather than raising the ceiling quietly.`
    );
  } finally {
    await browser.close();
  }
});
