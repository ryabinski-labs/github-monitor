# Prompt — dashboard contrast debt

Three sources, in this order. Nothing here is edited after intake.

## Source A — the ask, 2026-09-18

The user invoked `/spec-clarifier` with no argument, and chose this option when
asked what to clarify:

> **Dashboard contrast debt.** Issue #126 (dismissed rows at 2.56:1, from
> `opacity: 0.55` in styles.css:642) plus the metric-tile labels and two rail
> items I measured failing AA during #129. It is already filed, already
> measured, and it is the offer left open from my last message — so the spec
> starts from evidence rather than from scratch.

The option text is the agent's wording; what the user contributed is the choice
of it over "cron-only repos are never scanned" and over describing something
else. The scope is therefore the agent's reading and must be confirmed by the
interpretation question, not assumed.

## Source B — GitHub issue #126, verbatim

<https://github.com/ryabinski-labs/github-monitor/issues/126>

Title: `[UI]: dismissed rows fail WCAG AA contrast — opacity: 0.55 drags text to 2.56:1`
Opened 2026-09-18T10:46:40Z.

## Summary

Every dismissed row fails WCAG 2.2 AA contrast when revealed. `public/styles.css:1289` dims the whole row with `opacity: 0.55`, which composites every descendant against the page background. axe-core reports **24 `color-contrast` violations** (impact: serious) on the Failing CI lane, worst ratio **2.56:1** against the 4.5:1 requirement for small text.

This is pre-existing and global — it affects user dismissals, Dependabot auto-dismissals, and (after #124 / #125) cancelled runs equally. It is not caused by either of those PRs; it surfaced during their QA run.

## Evidence

Measured with axe-core 4.13 through headless Chromium against a running instance, Failing CI lane with the dismissed rows revealed via **Show**:

| element | foreground | background | size | ratio |
|---|---|---|---|---|
| `.row-dismissed .tag-group > .tag` | `#9b5756` | `#36292f` | 9.5px | **2.56:1** |
| `.row-dismissed .row-actions > .row-dismiss` | `#5e6c76` | `#1d2933` | 11px | **2.73:1** |

All 24 nodes are small text, so the 3:1 large-text allowance does not apply. WCAG 2.2 exempts only genuinely disabled controls; a de-emphasized but readable row is not exempt.

## Why it is not simply "raise the opacity"

Measured ladder, same page, same rule:

| `.row-dismissed` opacity | violations | worst ratio |
|---|---|---|
| 0.55 (current) | 24 | 2.56 |
| 0.70 | 12 | 3.31 |
| 0.80 | 8 | 3.87 |
| 0.85 | 4 | 4.19 |
| 0.90 | 0 | — |
| 1.00 | 0 | — |

Only 0.9 clears AA, and at 0.9 the dimming is close to invisible — the affordance the opacity exists for is gone. Opacity cannot both signal de-emphasis and hold contrast with these tokens, so this needs a different de-emphasis treatment rather than a number change.

`filter: grayscale(1)` with no opacity change also measured 0 violations (grayscale preserves relative luminance), which looks like a promising direction — rows lose their accent colour but keep full text contrast. It has not been visually reviewed and the interaction with `opacity` in the same rule was not conclusively measured.

## Reproduction

1. Run the dashboard with at least one dismissable row in Failing CI.
2. Dismiss a row, or let a Dependabot/cancelled run arrive auto-dismissed.
3. Click **Show** in the dismissed bar.
4. Run axe-core over the document with the `color-contrast` rule.

Note the CSP is `script-src 'self'`, so axe has to be served from a same-origin route rather than injected inline.

## Suggested next step

This is a visual-design decision about how the dashboard signals "de-emphasized", not a mechanical fix, so it should go through a visual review before a value is picked. Worth pairing with the repo's first automated accessibility test — `axe-core` is in `devDependencies` today but is imported by nothing, so there is no axe pass in the suite to regress against.

## Environment

- Branch `fix/auto-dismiss-cancelled-cd-runs` (also reproduces on `main` at 2302ab6)
- Chromium via Playwright 1.62, headless, 1440x900
- axe-core 4.13, tags `wcag2a`, `wcag2aa`, `wcag22aa`
- Dark theme verified. The light-theme run used the wrong localStorage key and re-measured dark, so **light theme is untested** and may differ.



## Source C — measured audit, 2026-09-18, on main at 41174e3

Evidence gathered while preparing this spec. Facts, not requirements.

axe-core 4.13, headless Chromium via Playwright, viewport 1440x900, tags
`wcag2a` `wcag2aa` `wcag22aa`, run over the whole document across the pass,
fail, conflicts, behind and running lanes in both themes.

**Dark theme: zero violations** in every lane. The dismissed-row case from
issue #126 did not reproduce in this fixture; the dismiss-then-Show step may not
have executed, so #126's dark-theme finding is neither confirmed nor refuted
here and still needs its own measurement.

**Light theme, nine violating nodes:**

| element | foreground | background | size | ratio |
|---|---|---|---|---|
| `.metric-label` (trace filters: flagged, active, completed, unknown) | `#aeaaa0` | `#f8f4ea` | 10px | **2.11:1** |
| `.metric-label` (running CD, finished CD, `.metric-ink`) | `#807c73` | `#fbf7ee` | 10px | **3.89:1** |
| `.tag` amber (behind and running lanes) | `#9a6312` | `#efddb8` | 9.5px bold | **3.76:1** |
| `.repo-owner` | `#7a7568` | `#faf6ec` | 10.5px | **4.25:1** |

`.repo-owner` was fixed separately in PR #130 and is out of scope here. The
amber `.tag` is the generic status pill; PR #127 introduced `--amber-on-soft`
(`#7b4f0e`, 5.29:1 on the same background) but applied it only to
`.behind-pill`.

**A measurement hazard found in the same audit.** axe cannot resolve a
background sitting over the row's `::before` accent bar and returns those nodes
as `incomplete` with `messageKey: "pseudoContent"` rather than as violations. At
Playwright's default 1280x720 viewport it returns every colour-contrast node in
`#content` that way, so an assertion reading only `violations` passes without
measuring anything. Fixed in PR #130 for the two existing axe tests; recorded
here because any acceptance criterion in this spec that leans on axe for colour
inherits the same trap.

## Repository facts relevant to the ask

- Themes are `:root` (dark, default) and `:root[data-theme="light"]`; there is
  no `prefers-color-scheme` media query. `public/theme.js` sets the attribute.
- Colour is entirely token-driven in `public/styles.css`; no build step, no
  preprocessor, zero runtime dependencies.
- `axe-core` is a devDependency and is used by `test/behind-base-ui.test.js` and
  `test/repo-identity-colours.test.js`.
- Tests are `node --test` with Playwright for DOM-level work.
- `.row-dismissed { opacity: 0.55 }` and `.row-dismissed:hover { opacity: 1 }`
  are at `public/styles.css:1338-1339` (issue #126 cites line 1289; the file has
  moved since).
