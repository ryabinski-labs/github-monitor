// The repo label is the first thing on every row, and in a list drawn from one
// owner it is fifteen identical characters followed by the one word that
// differs. These tests pin the two things that fix that: the owner recedes, and
// the repo segment carries a colour derived from the repo itself.
//
// public/app.js is a browser script with no exports, so the assignment rule is
// reached the only way it can be -- through a real page.
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

// The real spread this dashboard is asked to hold apart on one screen.
const REPOS = [
  "ryabinski-labs/waf",
  "ryabinski-labs/fieldwatt",
  "ryabinski-labs/primecam",
  "ryabinski-labs/yearclose",
  "ryabinski-labs/webemail",
  "ryabinski-labs/nightlamp-cluster",
  "ryabinski-labs/github-monitor",
  "ryabinski-labs/gipsychef",
  "ryabinski-labs/siftfy"
];

function passPr(repo, number) {
  return {
    repo,
    number,
    numberLabel: `#${number}`,
    title: "A pull request that is passing",
    author: "cigan1",
    url: `https://github.com/${repo}/pull/${number}`,
    state: "pass",
    checkCount: 4,
    isDraft: false,
    hasConflict: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    runningChecks: []
  };
}

function statusFixture(pass) {
  return {
    account: "ryabinski-labs",
    accounts: ["ryabinski-labs"],
    generatedAt: "2026-09-18T05:45:00Z",
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: REPOS.length,
      passingPrs: pass.length,
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
      tracingUnknown: 0
    },
    pullRequests: { pass, noCi: [], fail: [], running: [], conflicts: [], behind: [] },
    actions: { failed: [], running: [] },
    cd: { running: [], failed: [], finished: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [] },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

async function openDashboard({ theme = "dark" } = {}) {
  const browser = await chromium.launch();
  // An explicit viewport, because the default 1280x720 is not a neutral choice:
  // at that width axe returns every colour-contrast node as `incomplete` with
  // messageKey "pseudoContent" -- the row's ::before accent bar defeats its
  // background resolution -- and an assertion that only reads `violations` then
  // passes while proving nothing. See the incomplete check below.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const status = statusFixture(REPOS.map((repo, index) => passPr(repo, 100 + index)));

  await page.addInitScript(
    ([storedTheme]) => {
      localStorage.setItem("pr-deck:v1", JSON.stringify({ view: "pass", theme: storedTheme }));
      localStorage.removeItem("pr-deck:dismissed:v1");
      localStorage.removeItem("pr-deck:notified:v1");
      localStorage.removeItem("pr-deck:inbox:v1");
    },
    [theme]
  );

  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (pathname === "/theme.js") return route.fulfill({ contentType: "text/javascript", body: themeJs });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (pathname === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (pathname === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(status) });
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector(".row .repo-name");
  return { browser, page };
}

function relativeLuminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function parseColour(value) {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = value.trim().match(/^rgba?\(([^)]+)\)$/);
  if (!rgb) throw new Error(`unparseable colour: ${value}`);
  return rgb[1].split(",").slice(0, 3).map((part) => Number(part.trim()));
}

test("the owner is split off and only the repo segment is coloured", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    const first = await page.evaluate(() => {
      const row = document.querySelector(".row");
      return {
        owner: row.querySelector(".repo-owner")?.textContent ?? null,
        name: row.querySelector(".repo-name")?.textContent ?? null,
        colour: row.querySelector(".repo-name")?.dataset.repoColour ?? null,
        full: row.querySelector(".repo")?.textContent ?? null
      };
    });

    assert.equal(first.owner, "ryabinski-labs/", "the owner keeps its slash so the path still reads as a path");
    assert.ok(first.name && !first.name.includes("/"), "the coloured segment is the repo name alone");
    assert.equal(first.full, `${first.owner}${first.name}`, "splitting must not change the text the row shows");
    assert.match(first.colour, /^([1-9]|1[0-2])$/, "the repo segment carries a colour index in range");
  } finally {
    await browser.close();
  }
});

test("a repo keeps one colour, and different repos are told apart", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    const byRepo = await page.evaluate(() =>
      [...document.querySelectorAll(".row")].map((row) => ({
        repo: row.querySelector(".repo")?.textContent ?? "",
        colour: row.querySelector(".repo-name")?.dataset.repoColour ?? ""
      }))
    );

    assert.equal(byRepo.length, 9, "every row in the fixture must render");

    const assigned = new Map();
    for (const { repo, colour } of byRepo) {
      if (assigned.has(repo)) {
        assert.equal(assigned.get(repo), colour, `${repo} must have one colour, not two`);
      }
      assigned.set(repo, colour);
    }

    // Nine repos, twelve slots, so nothing has to repeat -- and nothing may.
    // Two repos sharing a colour on one screen is the exact confusion this is
    // meant to remove, which is why assignment is a registry and not a hash.
    const distinct = new Set(assigned.values()).size;
    assert.equal(
      distinct,
      assigned.size,
      `every repo on screen must have its own colour while the palette has room, got: ${[...assigned.entries()]
        .map(([repo, colour]) => `${repo}=${colour}`)
        .join(", ")}`
    );
  } finally {
    await browser.close();
  }
});

test("the colour survives a re-render, so it is identity and not paint order", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    const read = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll(".row")].map((row) => [
            row.querySelector(".repo")?.textContent ?? "",
            row.querySelector(".repo-name")?.dataset.repoColour ?? ""
          ])
        )
      );

    const before = await read();
    // Re-sort the rows by switching away and back: a fresh render of the same data.
    await page.click('.rail-item[data-view="conflicts"]');
    await page.click('.rail-item[data-view="pass"]');
    await page.waitForSelector(".row .repo-name");
    const after = await read();

    assert.deepEqual(after, before, "a repo's colour must not depend on where it happened to be rendered");
  } finally {
    await browser.close();
  }
});

for (const theme of ["dark", "light"]) {
  test(`every repo colour clears 4.5:1 on the row and on hover in the ${theme} theme`, { skip }, async () => {
    const { browser, page } = await openDashboard({ theme });
    try {
      const swatches = await page.evaluate(() => {
        const styles = getComputedStyle(document.documentElement);
        const read = (name) => styles.getPropertyValue(name).trim();
        return [
          ...Array.from({ length: 12 }, (_, index) => [`--repo-${index + 1}`, read(`--repo-${index + 1}`)]),
          ["--repo-owner-ink", read("--repo-owner-ink")]
        ];
      });

      // Not one background but every one a repo label actually lands on. Each
      // lane tints its rows, and the tinted conflict row is a harder background
      // than the plain one -- --muted cleared the plain row at 4.26:1 and still
      // failed the conflict row at 4.01:1, so checking a single surface is how a
      // failure hides.
      const backgrounds = new Map();
      for (const view of ["pass", "fail", "conflicts", "behind", "running"]) {
        const found = await page.evaluate((name) => {
          const rail = document.querySelector(`.rail-item[data-view="${name}"]`);
          if (!rail) return null;
          rail.click();
          const row = document.querySelector(".row");
          return row ? getComputedStyle(row).backgroundColor : null;
        }, view);
        if (found) backgrounds.set(found, view);
      }
      const hoverBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-hover").trim());
      backgrounds.set(hoverBg, "hover");
      assert.ok(backgrounds.size >= 2, "the sweep must find more than one row background to be worth running");

      for (const [token, swatch] of swatches) {
        assert.ok(swatch, `${token} must be defined in the ${theme} theme`);
        const colour = parseColour(swatch);
        for (const [background, where] of backgrounds) {
          const measured = contrast(colour, parseColour(background));
          assert.ok(
            measured >= 4.5,
            `${token} (${swatch}) is ${measured.toFixed(2)}:1 on the ${where} background (${background}) in the ${theme} theme; WCAG 2.2 AA needs 4.5:1`
          );
        }
      }
    } finally {
      await browser.close();
    }
  });

  test(`axe reports no structural violations around the repo labels in the ${theme} theme`, { skip }, async () => {
    const { browser, page } = await openDashboard({ theme });
    try {
      await page.addScriptTag({ content: axeJs });
      const results = await page.evaluate(async () => {
        const run = await window.axe.run("#content", {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
          // colour-contrast is measured above, from the token values against
          // every real row background. axe's own contrast rule cannot resolve a
          // background that sits over the row's ::before accent bar: it returns
          // those nodes as `incomplete` with messageKey "pseudoContent", and at
          // the default 1280px viewport it returns EVERY node that way. An
          // assertion that reads only `violations` therefore passed this file
          // and the one in behind-base-ui.test.js while proving nothing about
          // colour. Structure is what axe is reliable for here, so that is what
          // it is asked for.
          rules: { "color-contrast": { enabled: false } }
        });
        const flatten = (list, bucket) =>
          list.map((entry) => ({
            bucket,
            id: entry.id,
            nodes: entry.nodes.map((node) => node.target.join(" "))
          }));
        // `incomplete` is axe saying it could not decide, which is not the same
        // as a pass and must not be read as one. A contrast rule that cannot
        // resolve a background has not cleared the row -- it has declined to
        // look at it.
        return [...flatten(run.violations, "violation"), ...flatten(run.incomplete, "incomplete")];
      });

      assert.deepEqual(results, [], `axe findings in the ${theme} theme: ${JSON.stringify(results, null, 2)}`);
    } finally {
      await browser.close();
    }
  });
}
