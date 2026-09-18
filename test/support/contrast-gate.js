// The standing contrast gate: walks the rendered dashboard and reports every
// piece of text a reader would find below WCAG 2.2 AA 1.4.3.
//
// DL-004 chose "measure the rendered page" over a token table and over a
// combinatorial sweep of token pairs. The difference shows up in exactly one
// place, and it is the reason for the choice: a colour set inline, by a
// third-party style, or by a rule nobody remembered to add to the table is
// still on the page, and this gate still finds it. Coverage comes from the DOM,
// never from a list someone has to maintain.
//
// Three failures are reported as failures rather than quietly skipped:
//   - text below the threshold (the point);
//   - a background the gate cannot resolve to a flat colour (R-001: declining
//     to look is not the same as looking and finding nothing, and both of this
//     repo's earlier axe assertions failed exactly that way);
//   - animations that never settle (R-002: four of the five "defects" in this
//     spec's own source evidence were a staggered entrance fade measured
//     mid-flight).
import { contrastRatio, composite, parseColour, toHex } from "./contrast.js";

export const AA_TEXT_RATIO = 4.5;
export const SETTLE_CEILING_MS = 8000;

// The rows are the surface this spec is about. Scoping here rather than to the
// whole document is a scope decision, not an enumeration: within a row, every
// node is measured, including ones no stylesheet in this repo mentions.
const SCOPE = "#content .row";

// --- in-page probes ----------------------------------------------------------
//
// Passed to page.evaluate as real functions. A template-literal string would be
// treated as an expression and never receive its argument, which is how the
// first draft of this file measured `undefined` everywhere.

function collectAnimations() {
  return document
    .getAnimations()
    .filter((animation) => animation.playState !== "finished" && animation.playState !== "idle")
    .filter((animation) => {
      const target = animation.effect && animation.effect.target;
      // An element with no box is not being rendered, so its animation cannot
      // affect any colour we are about to measure. `.loader` spins forever
      // behind `.hidden`, and would otherwise hold the gate at the ceiling.
      return target && typeof target.getClientRects === "function" && target.getClientRects().length > 0;
    })
    .map((animation) => animation.animationName || animation.transitionProperty || animation.id || "unnamed")
    .filter((name, index, all) => all.indexOf(name) === index);
}

function measureScope({ scope, threshold }) {
  const parse = (value) => {
    const text = String(value == null ? "" : value).trim();
    if (!text || text === "transparent" || text === "none") return null;
    const match = text.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
  };
  const over = (top, bottom, alpha) => top.map((channel, index) => channel * alpha + bottom[index] * (1 - alpha));
  const hex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
  const describe = (element) => {
    const classes = String(element.className || "").split(/\s+/).filter(Boolean);
    return classes.length ? `${element.tagName.toLowerCase()}.${classes.join(".")}` : element.tagName.toLowerCase();
  };

  // Walks up compositing background-color layers until an opaque one is found.
  // Returns { rgb } or { unresolvable: <why> }. A background-image encountered
  // before that point means the pixel under the text is not a flat colour and
  // the gate must say so rather than guess at one.
  const backgroundUnder = (element) => {
    const layers = [];
    let node = element;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") {
        return { unresolvable: `background-image ${style.backgroundImage.slice(0, 40)} on ${describe(node)}` };
      }
      const parsed = parse(style.backgroundColor);
      if (parsed && parsed.alpha > 0) {
        layers.push(parsed);
        if (parsed.alpha === 1) {
          let stack = layers[layers.length - 1].rgb;
          for (let index = layers.length - 2; index >= 0; index -= 1) {
            stack = over(layers[index].rgb, stack, layers[index].alpha);
          }
          return { rgb: stack };
        }
      }
      node = node.parentElement;
    }
    return { unresolvable: `no opaque background above ${describe(element)}` };
  };

  // opacity on an ancestor composites the text toward its background. This is
  // the whole of issue #126: read the token and the row claims 8.7:1; read what
  // the reader sees and it is 2.56:1.
  const inheritedOpacity = (element) => {
    let node = element;
    let alpha = 1;
    while (node && node !== document.documentElement) {
      const value = Number(getComputedStyle(node).opacity);
      if (Number.isFinite(value)) alpha *= value;
      node = node.parentElement;
    }
    return alpha;
  };

  const luminance = (rgb) =>
    0.2126 * ((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))(rgb[0] / 255) +
    0.7152 * ((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))(rgb[1] / 255) +
    0.0722 * ((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))(rgb[2] / 255);
  const ratioOf = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const measured = [];
  const unresolvable = [];
  let skippedDisabled = 0;

  for (const root of document.querySelectorAll(scope)) {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const ownText = [...element.childNodes]
        .filter((child) => child.nodeType === 3)
        .map((child) => child.textContent.trim())
        .join(" ")
        .trim();
      if (!ownText) continue;

      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (!element.getClientRects().length) continue;

      // WCAG 2.2 exempts components that are genuinely inactive (A-007).
      // Counted rather than silently dropped, so "the gate found nothing"
      // cannot mean "the gate looked at nothing".
      const disabled = Boolean(element.closest("[disabled],[aria-disabled='true']"));

      const foreground = parse(style.color);
      if (!foreground) continue;

      const background = backgroundUnder(element);
      if (background.unresolvable) {
        unresolvable.push({ selector: describe(element), text: ownText.slice(0, 40), why: background.unresolvable });
        continue;
      }

      if (disabled) {
        skippedDisabled += 1;
        continue;
      }

      const alpha = foreground.alpha * inheritedOpacity(element);
      const composited = over(foreground.rgb, background.rgb, alpha);
      const ratio = Math.round(ratioOf(composited, background.rgb) * 100) / 100;

      // Large text has a lower bar in WCAG 1.4.3; the spec keeps one threshold
      // for everything, which is stricter, never looser.
      measured.push({
        selector: describe(element),
        text: ownText.slice(0, 40),
        foreground: hex(composited),
        background: hex(background.rgb),
        ratio,
        disabled: false,
        fontSizePx: Math.round(parseFloat(style.fontSize) * 10) / 10,
        fontWeight: style.fontWeight
      });
    }
  }

  return {
    measured,
    unresolvable,
    skippedDisabled,
    findings: measured.filter((node) => node.ratio < threshold)
  };
}

// --- driver ------------------------------------------------------------------

async function settle(page, ceilingMs) {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    const pending = await page.evaluate(collectAnimations);
    if (!pending.length) {
      // CSS transitions can be scheduled a frame after the change that caused
      // them, so an empty list on the first look is not yet proof of rest.
      await page.waitForTimeout(80);
      const again = await page.evaluate(collectAnimations);
      if (!again.length) return;
    }
    if (Date.now() >= deadline) {
      const names = await page.evaluate(collectAnimations);
      throw new Error(
        `contrast gate: animations did not settle within ${ceilingMs}ms — ${names.join(", ") || "unknown"}. ` +
          `Measuring mid-flight is how a staggered entrance fade gets reported as a contrast defect (R-002).`
      );
    }
    await page.waitForTimeout(100);
  }
}

async function currentSurface(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme || "dark",
    lane:
      document.querySelector(".rail-item.active")?.dataset.view ||
      document.querySelector("[data-view]")?.dataset.view ||
      "current"
  }));
}

async function setTheme(page, theme) {
  await page.evaluate((next) => {
    document.documentElement.dataset.theme = next;
    try {
      const settings = JSON.parse(localStorage.getItem("pr-deck:v1") || "{}");
      localStorage.setItem("pr-deck:v1", JSON.stringify({ ...settings, theme: next }));
    } catch {
      /* a blocked store changes nothing about what is on screen */
    }
  }, theme);
}

async function selectLane(page, lane) {
  const rail = page.locator(`.rail-item[data-view="${lane}"]`);
  if (!(await rail.count())) return false;
  await rail.first().click();
  return true;
}

async function revealOneDismissed(page) {
  const dismiss = page.locator('.row-dismiss[data-dismiss-action="dismiss"]').first();
  if (await dismiss.count()) {
    await dismiss.click().catch(() => {});
    await page.waitForTimeout(120);
  }
  const show = page.locator('button:has-text("Show")').first();
  if (await show.count()) await show.click().catch(() => {});
  await page.waitForTimeout(120);
}

/**
 * Runs the gate over `lanes` x `themes` x three states (at rest, with a
 * dismissed row revealed, and with a row hovered).
 *
 * Returns { findings, measured, summary }. Throws when animations do not settle
 * or a background cannot be resolved — both are "the gate could not decide",
 * and a gate that reports those as a pass is worse than no gate.
 */
export async function runContrastGate(page, options = {}) {
  const {
    lanes = ["pass", "fail", "conflicts", "behind", "running"],
    themes = ["dark", "light"],
    threshold = AA_TEXT_RATIO,
    settleCeilingMs = SETTLE_CEILING_MS,
    scope = SCOPE
  } = options;

  const startedAt = Date.now();
  const findings = [];
  const measured = [];
  const unresolvable = [];
  let surfaceStates = 0;
  let skippedDisabled = 0;

  const take = async (theme, lane, state) => {
    await settle(page, settleCeilingMs);
    const result = await page.evaluate(measureScope, { scope, threshold });
    surfaceStates += 1;
    skippedDisabled += result.skippedDisabled;
    const stamp = (node) => ({ ...node, theme, lane, state });
    measured.push(...result.measured.map(stamp));
    findings.push(...result.findings.map(stamp));
    unresolvable.push(...result.unresolvable.map(stamp));
    if (unresolvable.length) {
      // Reported at the first sight of it rather than at the end: the run that
      // could not decide should stop, and the message should be short enough
      // to act on.
      throw new Error(
        `contrast gate: could not resolve a background for ${unresolvable.length} node(s) — ` +
          unresolvable.map((node) => `${node.selector} (${node.why})`).join("; ") +
          `. Declining to look is not the same as looking and finding nothing (R-001).`
      );
    }
  };

  // The page as the caller handed it over, before anything is clicked. Anything
  // injected for a test, or left behind by the workflow under test, is measured
  // here — after this, navigating re-renders the lane and it would be gone.
  const opening = await currentSurface(page);
  await take(opening.theme, opening.lane, "as-handed-over");

  for (const theme of themes) {
    await setTheme(page, theme);
    for (const lane of lanes) {
      if (!(await selectLane(page, lane))) continue;
      await take(theme, lane, "rest");

      const row = page.locator(`${scope}`).first();
      if (await row.count()) {
        await row.hover().catch(() => {});
        await take(theme, lane, "hover");
        await page.mouse.move(0, 0).catch(() => {});
      } else {
        surfaceStates += 1; // an empty lane is still a state that was visited
      }

      await revealOneDismissed(page);
      await take(theme, lane, "dismissed-revealed");
    }
  }

  return {
    findings,
    measured,
    summary: {
      surfaceStates,
      wallClockMs: Date.now() - startedAt,
      threshold,
      nodesMeasured: measured.length,
      skippedDisabled,
      themes,
      lanes
    }
  };
}

/** One line per finding, carrying everything needed to act on it without re-running. */
export function formatFinding(finding) {
  return (
    `${finding.selector} "${finding.text}" — ` +
    `${finding.foreground} on ${finding.background} is ${finding.ratio.toFixed(2)}:1, needs 4.5:1 ` +
    `(${finding.theme} theme, ${finding.lane} lane, ${finding.state ?? "rest"}, ` +
    `${finding.fontSizePx}px/${finding.fontWeight})`
  );
}

export { contrastRatio, composite, parseColour, toHex };
