// Regression guard for a class-name collision: the refresh button's in-flight
// state reused the generic `loading` class, so the full-page scanning panel's
// `.loading { min-height: 36px; padding: 8px 14px; margin-bottom: 12px }` rule
// also applied to the button and lifted it off the toolbar baseline. The
// button keeps its own `is-loading` modifier, and its box must match its
// neighbours while a refresh is in flight.

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
const appJs = readFileSync(path.join(root, "public/app.js"), "utf8");
const stylesCss = readFileSync(path.join(root, "public/styles.css"), "utf8");
const files = {
  "/index.html": ["text/html", readFileSync(path.join(root, "public/index.html"), "utf8")],
  "/app.js": ["text/javascript", appJs],
  "/theme.js": ["text/javascript", readFileSync(path.join(root, "public/theme.js"), "utf8")],
  "/styles.css": ["text/css", stylesCss]
};

async function openDashboard() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    let pathname = new URL(request.url()).pathname;
    if (pathname === "/") pathname = "/index.html";
    if (files[pathname]) return route.fulfill({ contentType: files[pathname][0], body: files[pathname][1] });
    if (pathname === "/api/status") {
      // Hold the response so the in-flight (loading) state is observable.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    if (pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("http://localhost/");
  await page.waitForSelector("#refresh.is-loading");
  return { browser, page };
}

test("the refresh button keeps the toolbar baseline while refreshing", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    const boxes = await page.evaluate(() => {
      const pick = (selector) => {
        const el = document.querySelector(selector);
        const rect = el.getBoundingClientRect();
        return { top: Math.round(rect.top), height: Math.round(rect.height) };
      };
      const refresh = document.querySelector("#refresh");
      const hasGenericLoading = refresh.classList.contains("loading");
      const hasOwnLoading = refresh.classList.contains("is-loading");
      // A stale cached app.js would still toggle the generic `loading` class;
      // the toolbar must not shift even then.
      refresh.classList.add("loading");
      const staleHeight = Math.round(refresh.getBoundingClientRect().height);
      const staleMargin = getComputedStyle(refresh).marginBottom;
      refresh.classList.remove("loading");
      const scanPanel = document.querySelector("#loading");
      return {
        toggleGroup: pick(".toggle-group"),
        inbox: pick("#inboxToggle"),
        refresh: pick("#refresh"),
        hasGenericLoading,
        hasOwnLoading,
        staleHeight,
        staleMargin,
        scanPanelMinHeight: getComputedStyle(scanPanel).minHeight
      };
    });

    assert.equal(boxes.hasGenericLoading, false, "the refresh button must not reuse the generic .loading panel class");
    assert.equal(boxes.hasOwnLoading, true, "the refresh button carries its own .is-loading modifier");
    assert.equal(boxes.refresh.height, boxes.inbox.height, "refresh matches the bell's height");
    assert.equal(boxes.refresh.height, boxes.toggleGroup.height, "refresh matches the toggle rail's height");
    assert.equal(boxes.refresh.top, boxes.inbox.top, "refresh shares the bell's baseline");
    assert.equal(boxes.refresh.top, boxes.toggleGroup.top, "refresh shares the toggle rail's baseline");
    // The scan panel owns the `.loading` box model, scoped to #loading, so a
    // stale app.js toggling `loading` on the button cannot lift it.
    assert.equal(boxes.staleHeight, boxes.refresh.height, "a stale `loading` class does not resize the refresh button");
    assert.equal(boxes.staleMargin, "0px", "a stale `loading` class adds no margin to the refresh button");
    assert.equal(boxes.scanPanelMinHeight, "36px", "the scan panel still receives its own box model");
  } finally {
    await browser.close();
  }
});
