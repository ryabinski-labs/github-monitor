---
spec: spec-clarifier/v1
feature: dashboard-contrast
title: Dashboard contrast debt
status: complete
prompt: docs/prd/dashboard-contrast.prompt.md
prompt_sha256: 161d55a24b41ac8d97f195bd7e6164b02bcec891eec8b3af115c5add387fc801
created: 2026-09-18
---

# PRD: Dashboard contrast debt

## 0. Source prompt

> # Prompt — dashboard contrast debt
>
> Three sources, in this order. Nothing here is edited after intake.
>
> ## Source A — the ask, 2026-09-18
>
> The user invoked `/spec-clarifier` with no argument, and chose this option when
> asked what to clarify:
>
> > **Dashboard contrast debt.** Issue #126 (dismissed rows at 2.56:1, from
> > `opacity: 0.55` in styles.css:642) plus the metric-tile labels and two rail
> > items I measured failing AA during #129. It is already filed, already
> > measured, and it is the offer left open from my last message — so the spec
> > starts from evidence rather than from scratch.
>
> The option text is the agent's wording; what the user contributed is the choice
> of it over "cron-only repos are never scanned" and over describing something
> else. The scope is therefore the agent's reading and must be confirmed by the
> interpretation question, not assumed.
>
> ## Source B — GitHub issue #126, verbatim
>
> <https://github.com/ryabinski-labs/github-monitor/issues/126>
>
> Title: `[UI]: dismissed rows fail WCAG AA contrast — opacity: 0.55 drags text to 2.56:1`
> Opened 2026-09-18T10:46:40Z.
>
> ## Summary
>
> Every dismissed row fails WCAG 2.2 AA contrast when revealed. `public/styles.css:1289` dims the whole row with `opacity: 0.55`, which composites every descendant against the page background. axe-core reports **24 `color-contrast` violations** (impact: serious) on the Failing CI lane, worst ratio **2.56:1** against the 4.5:1 requirement for small text.
>
> This is pre-existing and global — it affects user dismissals, Dependabot auto-dismissals, and (after #124 / #125) cancelled runs equally. It is not caused by either of those PRs; it surfaced during their QA run.
>
> ## Evidence
>
> Measured with axe-core 4.13 through headless Chromium against a running instance, Failing CI lane with the dismissed rows revealed via **Show**:
>
> | element | foreground | background | size | ratio |
> |---|---|---|---|---|
> | `.row-dismissed .tag-group > .tag` | `#9b5756` | `#36292f` | 9.5px | **2.56:1** |
> | `.row-dismissed .row-actions > .row-dismiss` | `#5e6c76` | `#1d2933` | 11px | **2.73:1** |
>
> All 24 nodes are small text, so the 3:1 large-text allowance does not apply. WCAG 2.2 exempts only genuinely disabled controls; a de-emphasized but readable row is not exempt.
>
> ## Why it is not simply "raise the opacity"
>
> Measured ladder, same page, same rule:
>
> | `.row-dismissed` opacity | violations | worst ratio |
> |---|---|---|
> | 0.55 (current) | 24 | 2.56 |
> | 0.70 | 12 | 3.31 |
> | 0.80 | 8 | 3.87 |
> | 0.85 | 4 | 4.19 |
> | 0.90 | 0 | — |
> | 1.00 | 0 | — |
>
> Only 0.9 clears AA, and at 0.9 the dimming is close to invisible — the affordance the opacity exists for is gone. Opacity cannot both signal de-emphasis and hold contrast with these tokens, so this needs a different de-emphasis treatment rather than a number change.
>
> `filter: grayscale(1)` with no opacity change also measured 0 violations (grayscale preserves relative luminance), which looks like a promising direction — rows lose their accent colour but keep full text contrast. It has not been visually reviewed and the interaction with `opacity` in the same rule was not conclusively measured.
>
> ## Reproduction
>
> 1. Run the dashboard with at least one dismissable row in Failing CI.
> 2. Dismiss a row, or let a Dependabot/cancelled run arrive auto-dismissed.
> 3. Click **Show** in the dismissed bar.
> 4. Run axe-core over the document with the `color-contrast` rule.
>
> Note the CSP is `script-src 'self'`, so axe has to be served from a same-origin route rather than injected inline.
>
> ## Suggested next step
>
> This is a visual-design decision about how the dashboard signals "de-emphasized", not a mechanical fix, so it should go through a visual review before a value is picked. Worth pairing with the repo's first automated accessibility test — `axe-core` is in `devDependencies` today but is imported by nothing, so there is no axe pass in the suite to regress against.
>
> ## Environment
>
> - Branch `fix/auto-dismiss-cancelled-cd-runs` (also reproduces on `main` at 2302ab6)
> - Chromium via Playwright 1.62, headless, 1440x900
> - axe-core 4.13, tags `wcag2a`, `wcag2aa`, `wcag22aa`
> - Dark theme verified. The light-theme run used the wrong localStorage key and re-measured dark, so **light theme is untested** and may differ.
>
>
>
> ## Source C — measured audit, 2026-09-18, on main at 41174e3
>
> Evidence gathered while preparing this spec. Facts, not requirements.
>
> axe-core 4.13, headless Chromium via Playwright, viewport 1440x900, tags
> `wcag2a` `wcag2aa` `wcag22aa`, run over the whole document across the pass,
> fail, conflicts, behind and running lanes in both themes.
>
> **Dark theme: zero violations** in every lane. The dismissed-row case from
> issue #126 did not reproduce in this fixture; the dismiss-then-Show step may not
> have executed, so #126's dark-theme finding is neither confirmed nor refuted
> here and still needs its own measurement.
>
> **Light theme, nine violating nodes:**
>
> | element | foreground | background | size | ratio |
> |---|---|---|---|---|
> | `.metric-label` (trace filters: flagged, active, completed, unknown) | `#aeaaa0` | `#f8f4ea` | 10px | **2.11:1** |
> | `.metric-label` (running CD, finished CD, `.metric-ink`) | `#807c73` | `#fbf7ee` | 10px | **3.89:1** |
> | `.tag` amber (behind and running lanes) | `#9a6312` | `#efddb8` | 9.5px bold | **3.76:1** |
> | `.repo-owner` | `#7a7568` | `#faf6ec` | 10.5px | **4.25:1** |
>
> `.repo-owner` was fixed separately in PR #130 and is out of scope here. The
> amber `.tag` is the generic status pill; PR #127 introduced `--amber-on-soft`
> (`#7b4f0e`, 5.29:1 on the same background) but applied it only to
> `.behind-pill`.
>
> **A measurement hazard found in the same audit.** axe cannot resolve a
> background sitting over the row's `::before` accent bar and returns those nodes
> as `incomplete` with `messageKey: "pseudoContent"` rather than as violations. At
> Playwright's default 1280x720 viewport it returns every colour-contrast node in
> `#content` that way, so an assertion reading only `violations` passes without
> measuring anything. Fixed in PR #130 for the two existing axe tests; recorded
> here because any acceptance criterion in this spec that leans on axe for colour
> inherits the same trap.
>
> ## Repository facts relevant to the ask
>
> - Themes are `:root` (dark, default) and `:root[data-theme="light"]`; there is
>   no `prefers-color-scheme` media query. `public/theme.js` sets the attribute.
> - Colour is entirely token-driven in `public/styles.css`; no build step, no
>   preprocessor, zero runtime dependencies.
> - `axe-core` is a devDependency and is used by `test/behind-base-ui.test.js` and
>   `test/repo-identity-colours.test.js`.
> - Tests are `node --test` with Playwright for DOM-level work.
> - `.row-dismissed { opacity: 0.55 }` and `.row-dismissed:hover { opacity: 1 }`
>   are at `public/styles.css:1338-1339` (issue #126 cites line 1289; the file has
>   moved since).

## 1. Problem

The dashboard signals "this is de-emphasised" with `opacity`, and `opacity`
composites text toward the background. Every de-emphasised surface therefore
loses contrast in proportion to how de-emphasised it is, which is the one
direction contrast must never move. Issue #126 measured a dismissed row's tag at
**2.56:1** against the 4.5:1 that WCAG 2.2 AA requires for small text.

The operator reads this dashboard to decide what to act on. A dismissed row is
not deleted -- it is set aside and revealed again with **Show**, at which point
it has to be readable, because the reason to reveal it is to re-read it.

Two things make this worth a gate rather than three edits. First, the failures
keep arriving one surface at a time: #127 introduced `--amber-on-soft` to fix
the amber pill and applied it to `.behind-pill` only, leaving the generic `.tag`
broken in the same PR; #129 shipped `.repo-owner` at 4.26:1 the next day.
Second, and worse, the checks that existed did not catch either, and the audit
written to find them was itself wrong twice (§8, R-001 and R-002). The problem
is not a list of colours. It is that nothing measures contrast correctly and
nothing measures it at all for composited surfaces.

## 2. Target user

- **Primary:** the single operator running this dashboard locally, in either
  theme, including at reduced contrast sensitivity or on a glare-washed screen.
- **Secondary:** anyone reading the repository as an accessibility reference; the
  project ships a WCAG claim in its own PR descriptions and should be able to
  keep it.
- **Explicitly not for:** no user is served worse. There is no cohort this
  trades against.
- **Job-to-be-done:** When I reveal something I set aside earlier, I want to read
  it as easily as anything else on the board, so I can decide whether it still
  needs me.

*From repo: this is a single-user local dashboard. There is no account model, no
role table and no multi-tenancy anywhere in `server.js` -- so "actors" and
"permissions" have exactly one answer and are not open questions.*

## 3. Outcome and success metric

- **Outcome this moves:** readability of de-emphasised content, and the ability
  to keep it readable without anyone remembering to check.
- **Primary KPI:** count of WCAG 2.2 AA 1.4.3 text-contrast violations reported
  by the gate over the rendered dashboard, at rest, across every lane, both
  themes, and the dismissed and hover states. Measured by the gate itself, in
  `npm test`.
- **Baseline, measured 2026-09-18 on `main` at 74fe305:** **1** violation at
  rest (`.tag` amber, 3.76:1, light theme) and **15 dark / 19 light** once
  dismissed rows are revealed, worst 2.56:1 dark and 2.15:1 light.
- **Target:** **0** violations in every state the gate covers, enforced from the
  commit that lands it.
- **Guardrail metrics:** `npm test` wall-clock must not rise by more than 60 s
  (A-003); a dismissed row must remain visually distinguishable from a live one
  at a glance, which is the affordance the opacity existed for.

## 4. Goals and non-goals

**Goals**
1. A revealed dismissed row meets 4.5:1 on every piece of text it contains, in
   both themes.
2. The amber status pill meets 4.5:1 in both themes.
3. A contrast failure on any surface the dashboard renders fails `npm test`
   before it can be merged, without anyone having to add that surface to a list.

**Non-goals**
1. **Non-text contrast (WCAG 1.4.11).** Borders, the row accent bar, the rail
   dots, button outlines and focus rings are not measured (DL-003). They may all
   pass or all fail; nobody has looked, and looking would change the size of this
   work by an unknown amount.
2. **A colour-system redesign.** Tokens that pass today are not revisited, even
   where they pass narrowly (DL-001 rejected this reading explicitly).
3. **`.repo-owner`.** Fixed in PR #130 before this spec was written; it is
   evidence here, not scope.
4. **Making axe the contrast oracle.** It cannot resolve a background sitting
   over the row's `::before` bar (§8 R-001). axe stays for structural rules.
5. **Disabled controls.** WCAG 2.2 exempts inactive components; the gate skips
   `[disabled]` rather than forcing `.merge-button:disabled` and friends to 4.5:1.

## 5. User stories and acceptance criteria

- **[P0]** As the operator, I want a revealed dismissed row to be as readable as a live one, so that setting something aside does not cost me the ability to re-read it.
  - [ ] Given a dismissed row revealed with **Show**, when it renders in the dark theme, then every text node in it measures at least 4.5:1 against its own background.
  - [ ] Given the same row in the light theme, then every text node in it measures at least 4.5:1.
  - [ ] Given a dismissed row beside a live one, when both render, then the dismissed row carries no accent colour -- its left bar, its status pill, its repo name and its buttons are all greyscale -- and the live row keeps all of its colour.
  - [ ] Given a dismissed row, when the pointer enters it, then it returns to full colour, as `.row-dismissed:hover` does today.

- **[P0]** As the operator, I want the amber status pill to be readable in the light theme, so that a lane I am being pointed at is not the hardest one to read.
  - [ ] Given a `.tag` rendered in amber in the light theme, when it renders, then its text measures at least 4.5:1 against the pill background.
  - [ ] Given the same pill in the dark theme, then it measures at least 4.5:1.

- **[P0]** As a future change to this repository, I want a contrast failure to fail the test suite, so that the next de-emphasised surface cannot ship broken the way the last three did.
  - [ ] Given the dashboard rendered at rest, when the gate runs over every lane in both themes, then it reports every text node whose measured contrast is below 4.5:1, naming the element, the two colours and the ratio.
  - [ ] Given a surface that no list mentions, when it renders text, then the gate measures it anyway -- coverage comes from what the page produces, not from an enumeration someone maintains (DL-004).
  - [ ] Given text whose colour is composited by `opacity` or `filter`, when the gate measures it, then it measures the composited result, not the token value.
  - [ ] Given the page still running its entrance animation, when the gate runs, then it waits for `document.getAnimations()` to settle first and measures the resting state.
  - [ ] Given a `[disabled]` control, when the gate runs, then it is skipped.
  - [ ] Error: given a node whose background the gate cannot resolve, then the gate fails naming that node, rather than passing it over -- "could not decide" is not "fine" (§8 R-001).

- **[P0]** As the operator, I want the gate to tell me what to change, so that a red suite is a repair instruction and not a puzzle.
  - [ ] Given a failure, when the message is printed, then it names the CSS selector, the measured foreground and background as hex, the ratio to two decimals, the required ratio, and the theme and lane it was found in.

Priorities: **P0** release fails without it · **P1** ship-blocking unless waived · **P2** follow-up.

## 6. Experience notes

The only visible change is how a dismissed row looks: `filter: grayscale(1)`
with opacity returned to `1`, replacing `opacity: 0.55` at
`public/styles.css:1350`. Rendered and reviewed in both themes -- the dismissed
row's accent bar, status pill, repo colour and buttons all go grey while live
rows keep theirs. In an interface whose entire language is colour, the absence
of colour is a strong signal, and unlike dimming it costs no legibility:
greyscale preserves relative luminance, so text contrast is mathematically
unchanged. `.row-dismissed:hover { opacity: 1 }` becomes
`.row-dismissed:hover { filter: none }`.

The amber pill changes from `--amber` to `--amber-on-soft`, which already exists
(A-005). In the light theme it is a darker amber; in dark it is unchanged, since
`--amber-on-soft` is defined as `var(--amber)` there.

Nothing else moves. No layout, no copy, no new controls, no loading or empty
states, and no mobile-specific behaviour -- the gate is a test and has no
surface at all.

- **Accessibility bar:** WCAG 2.2 AA, success criterion 1.4.3 (Contrast
  Minimum), 4.5:1 for text under 18.66px bold / 24px regular. 1.4.11 is out of
  scope by DL-003.

## 7. Scope

**In scope:**
- `.row-dismissed` de-emphasis treatment, both themes.
- The amber `.tag`, both themes.
- A rendered-page contrast gate covering the pass, fail, conflicts, behind and
  running lanes, in both themes, at rest, plus the dismissed-revealed and hover
  states (A-001).

**Out of scope:** everything in §4 non-goals.

**Dependencies:** none outside the repository. `axe-core`, `playwright` and
`node --test` are already devDependencies and already wired into
`test/behind-base-ui.test.js` and `test/repo-identity-colours.test.js`.

**Constraints** *(from repo)*:
- Zero runtime dependencies, no build step, no CSS preprocessor. Colour is
  token-driven in `public/styles.css`; a fix is a token or a rule, never a
  pipeline.
- Themes are `:root` (dark, default) and `:root[data-theme="light"]`, set by
  `public/theme.js`. There is no `prefers-color-scheme` query, so the gate
  drives the attribute rather than emulating a media feature.
- CSP is `script-src 'self'`, so axe is injected by Playwright in tests rather
  than served to the browser.
- All changes ship via pull request and merge through CI.

## 8. Risks and open questions

| ID | Risk or question | Type | Owner | Resolve by |
|---|---|---|---|---|
| R-001 | **axe cannot be trusted for contrast here, and its failure mode is silence.** It cannot resolve a background sitting over the row's `::before` accent bar and returns those nodes as `incomplete` with `messageKey: "pseudoContent"`, not as violations. At Playwright's default 1280x720 viewport it returns *every* colour-contrast node in `#content` that way, so both existing assertions passed while measuring nothing. Widening to 1440x900 turned the same page into nine real violations. Fixed for the two existing tests in PR #130; the gate must not reintroduce it, which is why DL-004 chose measurement over axe. | Risk | Implementer | Closed by PR #130 and by the §5 criterion on unresolvable backgrounds |
| R-002 | **The audit in §0 Source C overstated the problem, and the spec supersedes it.** Those runs measured mid-animation: `.metric-group` has a staggered entrance fade (`public/styles.css:752-761`, delays 30/100/170/240 ms) and axe caught the labels at partial opacity. Re-measured with `document.getAnimations()` settled, the `.metric-label` findings at 2.11:1 and 3.89:1 **do not exist** -- the resting colour is `--muted-strong` at 6.39:1. Of the four reported failures only the amber `.tag` at 3.76:1 is real. §0 is evidence and is not edited; this row is the correction. | Defect in the evidence | Implementer | Closed; baseline in §3 is the corrected figure |
| R-003 | A gate that walks every text node on every lane in both themes is the slowest test in the suite, and a slow suite gets skipped. Bounded by A-003. | Risk | Implementer | First run; if the budget is missed, narrow the state matrix before narrowing the surface coverage |
| R-004 | `filter: grayscale(1)` creates a containing block and a new stacking context. Any `position: fixed` descendant of a dismissed row, or any transform-based overlay anchored inside one, would be re-parented to the row. No such descendant exists today (rows contain text, tags and buttons only), but it is a real constraint on what may later be nested inside a row. | Risk | Implementer | Accepted; the §5 hover criterion exercises the stacking path |

No open questions block a requirement.

## 9. Instrumentation

No product analytics: this dashboard sends no telemetry anywhere, by design
*(from repo: there is no analytics client in `public/` or `server.js`)*. The one
measurement that matters is the gate's own output.

| Event | Trigger | Properties | Purpose |
|---|---|---|---|
| gate failure line | a text node measures below 4.5:1 | selector, foreground hex, background hex, measured ratio, required ratio, theme, lane | the §5 P1 criterion: a red suite must say what to change |
| gate summary | the gate finishes | nodes measured, surfaces visited, wall-clock | proves coverage did not silently shrink, and tracks A-003 |

## 10. Rollout and rollback

- **Strategy:** full, in one pull request. *(From repo: there is no feature-flag
  mechanism and no staged rollout -- `start.sh` runs one process for one
  operator, and merging to `main` is the release.)*
- **Rollback trigger:** the gate failing on `main` for a reason unrelated to a
  real contrast defect -- a flake, an animation not settling, a headless-render
  difference. Revert the gate, keep the two colour fixes; they are independent
  commits for exactly that reason.
- **Migration or backfill:** none. No stored state, no schema, nothing to
  migrate. The `pr-deck:dismissed:v1` localStorage key is untouched.

## 11. Compliance gates

- [x] **Accessibility (WCAG 2.2 AA, 1.4.3).** This is the gate; §5 carries the
      criteria.
- [ ] Privacy, security, legal, data-retention: **none apply.** No personal data
      is read, written or transmitted by any part of this change. A CSS filter
      and a test that reads computed styles have no data surface at all.

## 12. Data and integrations

- **Stored:** nothing new. No new localStorage key, no server-side state.
- **Migration:** none.
- **Integrations:** none. The gate drives a page Playwright serves from the
  repository's own files, with `/api/status` fulfilled from a fixture -- the
  same pattern `test/repo-identity-colours.test.js` uses today. No network, no
  GitHub API, no token.

## 13. Non-functional requirements

- Every text node the gate measures must be at or above **4.5:1**, measured as WCAG 2.x relative luminance on the composited sRGB values, in both themes.
- The gate must visit at least **5 lanes x 2 themes x 3 states** (resting, dismissed-revealed, hover) = 30 surface-states, and must fail if it visits fewer, so shrinking coverage cannot look like passing.
- The gate must add no more than **60 s** to `npm test` wall-clock (A-003).
- The gate must measure only after `document.getAnimations()` reports every animation `finished` or `idle`, with an **8 s** ceiling on that wait before it fails loudly.
- Viewport is pinned at **1440x900** (A-004).

## 14. Assumptions

| ID | Dimension | Assumption | Why this default | Overturn if |
|---|---|---|---|---|
| A-001 | states | The gate covers resting, dismissed-revealed and hover. Focus-visible is not covered. | DL-004's wording named these three. Focus rings are non-text and fall under 1.4.11, which DL-003 put out of scope. | You want keyboard-only surfaces covered, which pulls 1.4.11 back in. |
| A-002 | triggers | The gate is a `node --test` file, run by `npm test`, and therefore by CI on Node 22.x and 24.x. No separate workflow. | Every existing check in this repo works that way; a separate job would be the only one. | The gate's runtime makes the main suite unpleasant, and it needs its own job. |
| A-003 | non_functional | Budget: 60 s added to `npm test`. | The suite is currently a few tens of seconds and 30 surface-states at roughly a second each is the honest order of magnitude. Not measured -- there is no gate to measure yet. | The first real run lands far from this; then the number is replaced with the measured one, not the guess. |
| A-004 | interface | Viewport pinned to 1440x900. | Measured: at the 1280x720 default, axe returns every colour-contrast node as `pseudoContent` incomplete (R-001). 1440x900 is what PR #130 pinned for the same reason. | A narrower breakpoint has its own contrast behaviour worth gating, in which case the gate takes a viewport matrix. |
| A-005 | interface | The amber pill reuses the existing `--amber-on-soft` (`#7b4f0e` light, `var(--amber)` dark) rather than a new token. | The token exists for exactly this pair and measures 5.29:1 on `--amber-soft`; #127 simply did not apply it beyond `.behind-pill`. A second token for the same job is how this drifts again. | The generic `.tag` needs to read differently from the behind pill, which is a design decision, not a contrast one. |
| A-006 | outputs | The gate walks the whole document, not just `#content`. | The rail and the scoreboard are where the false positives in R-002 came from; excluding them would mean never learning whether they are really clean. | The rail or scoreboard turns out to need its own treatment and its own test. |
| A-007 | states | `[disabled]` controls are skipped. | WCAG 2.2 exempts inactive user-interface components from 1.4.3. `.merge-button:disabled` and `.close-button:disabled` sit at `opacity: 0.72` and would otherwise fail. | You would rather hold disabled controls to the same bar than rely on the exemption. |

## 15. Decision log

| ID | Dimension | Question | Options offered | Answer | Applied in |
|---|---|---|---|---|---|
| DL-001 | purpose | Which of these is the thing you actually want built? | A. Fix + standing gate; B. Fix the measured failures only; C. Issue #126 only; D. Re-derive the colour system for AA | **A — fix + standing gate** | §1, §3, §4, §5 |
| DL-002 | interface | How should a dismissed row signal "set aside" without losing contrast? | A. Grayscale, no dimming; B. Raise the opacity; C. Grayscale plus dimming; D. A structural marker | **A — grayscale, no dimming**; measured 0 violations in both themes, where no single opacity value clears both | §5, §6 |
| DL-003 | non_functional | What does the contrast gate check? | A. Text only, 4.5:1; B. Text plus non-text 3:1 (WCAG 1.4.11); C. Text plus focus rings only | **A — text only, 4.5:1** | §4, §13 |
| DL-004 | outputs | How should the gate decide what to measure? | A. Measure the rendered page; B. A hand-maintained token-pair table; C. Every ink token x every surface token | **A — measure the rendered page**; the only design that cannot be defeated by forgetting a pair, and the only one that sees composited `opacity` and `filter` | §5, §7 |
| DL-005 | acceptance | Which stories are P0 -- the release fails without them? | A. The three recommended (dismissed row, amber pill, gate); B. Any subset of the four | **All four**, including the failure message, which moves up from P1: a gate that fails without saying what to change is a release blocker, not a follow-up | §5 |
| DL-006 | non_functional | A-003's overturn condition has been met — should the guessed 60 s budget be replaced with the first real measurement? | A. Record the measurement, keep the 60 s budget as the ceiling; B. Tighten the ceiling to the measurement; C. Leave the guess in place | **A — measured 12.5 s on 31 surface-states and 678 nodes; budget stays 60 s.** Tightening to ~12 s would make the suite fail on any slower runner without a contrast defect existing, which is a flake, not a gate. The headroom is now 4.8x and is recorded rather than assumed. Supersedes A-003. | §13, A-003 |

## Coverage

| Dimension | Status | Ref |
|---|---|---|
| purpose | specified | §1,§3,DL-001 |
| actors | specified | §2 |
| permissions | specified | §2 |
| triggers | specified | §5,A-002 |
| inputs | specified | §5,§12 |
| outputs | specified | §9,A-006,DL-004 |
| states | assumed | A-001,A-007 |
| errors | specified | §5,§9 |
| interface | specified | §6,A-004,A-005 |
| data | specified | §12 |
| integrations | specified | §12 |
| non_functional | specified | §13,A-003,DL-003 |
| constraints | specified | §7 |
| non_goals | specified | §4 |
| acceptance | specified | §5,DL-005 |
| rollout | specified | §10 |
