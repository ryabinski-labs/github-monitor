// Red-phase coverage for the dashboard's contrast gate — the arithmetic half.
//
// Derived from docs/prd/dashboard-contrast.md via tdd/dashboard-contrast.tdd.yaml.
// Every test name carries its scenario ID verbatim; that ID is the join key
// between this suite, the artifact and any QA results file, so never rename it.
//
// These are expected to FAIL until the gate lands. They fail on assertions, not
// on link errors: the module under test is reached through a dynamic import in a
// try/catch so that "it does not exist yet" is a readable sentence rather than a
// stack trace that takes the whole file down with it.
import test from "node:test";
import assert from "node:assert/strict";

async function loadContrast() {
  try {
    return await import("./support/contrast.js");
  } catch {
    return null;
  }
}

// --- REQ-009: the computation itself ------------------------------------------

test("SC-contrast-ratio-known-pairs: the ratio computation agrees with published values", async () => {
  // Oracle: ratio(#000,#fff) === 21.00 && ratio(#767676,#fff) === 4.54 && ratio(#777777,#fff) === 4.48
  const contrast = await loadContrast();
  assert.ok(
    contrast && typeof contrast.contrastRatio === "function",
    "test/support/contrast.js must export contrastRatio(a, b); the gate's every claim rests on it"
  );

  const round = (value) => Math.round(value * 100) / 100;

  assert.equal(round(contrast.contrastRatio("#000000", "#ffffff")), 21, "black on white is the defined maximum");

  // #767676 on white is the canonical WCAG boundary: the lightest grey that
  // passes AA on white. #777777 is one step lighter and fails. A computation
  // that gets the boundary wrong by a rounding rule sails through a
  // black-on-white check and then misjudges real text, which is the only place
  // it matters.
  assert.equal(
    round(contrast.contrastRatio("#767676", "#ffffff")),
    4.54,
    "#767676 on white is the lightest grey that passes AA; it must measure 4.54:1"
  );
  assert.equal(
    round(contrast.contrastRatio("#777777", "#ffffff")),
    4.48,
    "#777777 on white must measure 4.48:1 — one step lighter and it fails, and the gate has to see that"
  );
});

test("SC-contrast-composite-alpha: compositing an alpha over a background is done before the ratio", async () => {
  // Oracle: composite(#ffffff,#000000,1) === #ffffff && (…,0) === #000000 && (…,0.55) === #8c8c8c
  const contrast = await loadContrast();
  assert.ok(
    contrast && typeof contrast.composite === "function",
    "test/support/contrast.js must export composite(foreground, background, alpha); without it opacity is invisible to the gate, which is issue #126 exactly"
  );

  assert.equal(
    contrast.composite("#ffffff", "#000000", 1).toLowerCase(),
    "#ffffff",
    "a fully opaque foreground is unchanged"
  );
  assert.equal(
    contrast.composite("#ffffff", "#000000", 0).toLowerCase(),
    "#000000",
    "a fully transparent foreground collapses to its background"
  );
  // 0.55 is not an arbitrary probe: it is the opacity issue #126 is about.
  assert.equal(
    contrast.composite("#ffffff", "#000000", 0.55).toLowerCase(),
    "#8c8c8c",
    "white at 0.55 over black composites to #8c8c8c — the number the gate has to reach to see a dimmed row at all"
  );
});
