# UI handoff: Out-of-date PR lane

Companion to `docs/prd/pr-behind-base.md`. Covers the three components in §6 of that spec:
the rail item, the behind pill, and the Update branch button. Every value below is taken
from the existing design system in `public/styles.css`; nothing new is invented except one
token, and that token exists to fix a measured contrast failure.

## Design constraints taken from the repo

| Constraint | Source | Consequence |
|---|---|---|
| Two themes, switched by `data-theme` on `<html>` | `public/theme.js` | Every colour decision must be checked twice. The light theme is where this feature nearly shipped an AA failure. |
| `--*-on-soft` token convention already exists | `styles.css:28` (`--flag-on-soft`) | The contrast fix follows an established pattern rather than introducing a new idea. |
| Exactly one filled button per row, in every lane | `.merge-button` / `.rerun-button` filled; `.close-button` / `.open-link` outlined | The new lane must not break the invariant. This is descriptive of the system, not a preference. |
| No inline scripts or styles | `SECURITY_HEADERS`, `server.js:55`, enforced by `test/csp.test.js` | All styling lands in `styles.css`; all behaviour in `app.js`. |
| Zero runtime dependencies | `package.json` has no `dependencies` block | No icon library. Icons are inline SVG, matching `.conflict-pill svg` and `.rerun-button svg`. |
| Reduced motion is globally honoured | `styles.css:2130` | The spinner needs no separate handling; the global rule already neutralises it. |

## Measured contrast

Computed from WCAG relative luminance on the token hex values, not judged by eye.

| Pair | Dark | Light | AA (4.5:1) |
|---|---|---|---|
| Pill text on `--amber-soft`, using `var(--amber)` | 6.15:1 | **3.77:1** | **fails in light** |
| Pill text on `--amber-soft`, using `--amber-on-soft` | 6.15:1 | 5.29:1 | passes |
| Filled button: `--paper-strong` on `--amber` | 8.49:1 | 4.67:1 | passes |
| Rail dot `--amber` on `--paper-card` | 7.86:1 | 4.83:1 | passes (non-text, 3:1 floor) |
| Reference: existing `.conflict-pill` red on `--red-soft` | 5.22:1 | 4.79:1 | passes |

The light-theme pill is the finding that matters: copying `.conflict-pill` and swapping red
tokens for amber would have shipped a 3.77:1 failure, because `--amber` is tuned as a *dot and
border* colour in light mode, not as body text on a tinted ground.

## 1. Tokens

Add one token to each theme block in `public/styles.css`.

```css
/* :root — dark (after --amber-soft, line ~20) */
  /* Amber reads well as a dot or a border on the light paper, but as 9.5px text on
     --amber-soft it measures 3.77:1 there — under the 4.5:1 AA floor. This token is the
     text-on-tint variant, same idea as --flag-on-soft above. Dark needs no correction. */
  --amber-on-soft: var(--amber);

/* :root[data-theme="light"] — light (after --amber-soft, line ~69) */
  --amber-on-soft: #7b4f0e;   /* 5.29:1 on --amber-soft */
```

## 2. Rail item

**Markup** — `public/index.html`, directly after the Conflicts `.rail-item` (line ~286), so the
two blocked lanes sit together:

```html
<button class="rail-item" type="button" data-view="behind">
  <span class="dot behind"></span>
  Out of date
  <strong id="navBehind">0</strong>
</button>
```

**Wiring** — `public/app.js`:

```js
// views map (~line 112, after `conflicts`)
behind: {
  kicker: "Out of date",
  title: "PRs whose branch is behind the base branch",
  empty: "No PRs waiting on a branch update.",
  color: "amber",
  rows: (data) => data.pullRequests.behind || []
},

// viewOrder (~line 178)
const viewOrder = ["fail", "conflicts", "behind", "running", "pass", "noCi", /* …unchanged */];

// navIds (~line 245)
behind: "navBehind",
```

**Dot** — `styles.css`, beside `.dot.conflict` (line ~895):

```css
/* Amber is already the `running` lane's dot, so hue alone would not separate the two
   in a five-item rail. A ring reads as a state that is stuck; a filled dot reads as a
   state that is live. The distinction survives greyscale and colour-blind viewing. */
.dot.behind {
  color: var(--amber);
  background: transparent;
  box-shadow:
    inset 0 0 0 1.5px currentColor,
    0 0 0 2.5px color-mix(in srgb, currentColor 22%, transparent);
}
```

No other rail CSS changes: `.rail-item`, its `.active` state, and the `strong` count are
inherited unchanged, which keeps the count announced as part of the button's accessible name.

## 3. Behind pill

Sits in `.tag-group` beside the existing Conflict and Draft pills. Because `hasConflict` wins
the lane (DL-005), the behind pill and the conflict pill never appear together.

**Render** — `public/app.js`, beside `conflictBadge` in `renderPrRow`:

```js
const behindBadge = row.behindBy > 0
  ? `<span class="behind-pill" title="${escapeHtml(
       `${row.behindBy} commit${row.behindBy === 1 ? "" : "s"} behind ${row.baseRefName} — merge the latest ${row.baseRefName} into this branch`
     )}">
       <svg viewBox="0 0 24 24" aria-hidden="true">
         <path d="M12 5v14m0 0-6-6m6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
       </svg>
       ${escapeHtml(String(row.behindBy))} behind <span class="behind-pill-ref">${escapeHtml(row.baseRefName)}</span>
     </span>`
  : "";
```

The visible text drops the word "commits": at 9.5px with 0.12em tracking the full sentence
renders ~165px and crowds `[FAIL] [DRAFT]` beside it. The full sentence stays in `title`.

**Style** — `styles.css`, after `.draft-pill`:

```css
.behind-pill {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  max-width: 100%;
  padding: 3px 8px 3px 6px;
  border: 1px solid color-mix(in srgb, var(--amber) 32%, transparent);
  border-radius: var(--radius-pill);
  background: var(--amber-soft);
  color: var(--amber-on-soft);
  font-family: var(--sans);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  white-space: nowrap;
}
.behind-pill svg { width: 11px; height: 11px; flex: 0 0 auto; stroke: currentColor; }

/* A base ref can be `release/2026-09-hotfix`. The pill is nowrap, so an untruncated
   long ref pushes the row into horizontal overflow at 1280px. Truncate the ref only —
   the number must never be the part that disappears. */
.behind-pill-ref {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22ch;
}
```

## 4. Update branch button

**Render** — `public/app.js`, inside `renderPrActions`, emitted before the merge button:

```js
const isUpdating = state.updating.has(key);
const isUpdated  = state.updated.has(key);
const updateLabel = isUpdated ? "Updated" : isUpdating ? "Updating" : "Update branch";
const updateButton = row.behindBy > 0
  ? `<button
       class="update-button"
       type="button"
       data-repo="${escapeHtml(row.repo)}"
       data-number="${escapeHtml(row.number)}"
       data-title="${escapeHtml(row.title)}"
       data-state="${isUpdated ? "updated" : isUpdating ? "updating" : "ready"}"
       aria-label="${escapeHtml(`${updateLabel} ${row.repo} ${row.numberLabel}`)}"
       title="${escapeHtml(
         isUpdated ? "GitHub accepted the branch update"
         : isUpdating ? "Asking GitHub to update this branch…"
         : `Merge the latest ${row.baseRefName} into this branch`
       )}"
       ${isUpdating || isUpdated || isMerging || isClosing ? "disabled" : ""}
     >
       <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m0 0-6-6m6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
       <span>${escapeHtml(updateLabel)}</span>
     </button>`
  : "";
```

The icon is the same down-arrow as the pill: one glyph means "bring base down into this
branch" in both places. It is `aria-hidden`; the label carries the meaning.

**States** — four, matching `.merge-button` and `.rerun-button` exactly:

| State | `data-state` | Appearance | Disabled |
|---|---|---|---|
| ready | `ready` | filled amber, `--paper-strong` text | no |
| in flight | `updating` | filled amber, icon spinning, `cursor: wait` | yes |
| done | `updated` | `--amber-soft` ground, `--amber-on-soft` text, full opacity | yes |
| failed | `ready` | returns to ready; the reason is in the toast and error panel | no |

There is no distinct failed *style* — deliberately. Merge, close and rerun all report failure
through the toast plus `#errorPanel` and restore the button, so a red button variant would be
the only place in the dashboard where a failure is encoded in a control's colour.

**Style** — `styles.css`, after `.close-button` rules:

```css
.open-link, .merge-button, .close-button, .rerun-button, .update-button { /* add to the shared selector at line ~1370 */ }

.update-button {
  border-color: var(--amber);
  background: var(--amber);
  color: var(--paper-strong);
  white-space: nowrap;
}
.update-button svg { width: 13px; height: 13px; flex: 0 0 auto; }
.update-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--amber) 84%, black);
  background: color-mix(in srgb, var(--amber) 84%, black);
}
.update-button:disabled { cursor: wait; opacity: 0.82; }
.update-button[data-state="updating"] svg { animation: spin 0.9s linear infinite; }
.update-button[data-state="updated"] {
  border-color: color-mix(in srgb, var(--amber) 58%, var(--line-strong));
  background: var(--amber-soft);
  color: var(--amber-on-soft);
  cursor: default;
  opacity: 1;
}
.update-button:focus-visible { /* add to the shared focus-visible group at line ~1474 */ }
```

## 5. Preserving one filled primary per row

A failing, behind, mergeable PR would otherwise render `[Rerun failed]` (filled blue),
`[Update branch]` (filled amber) and `[Merge]` (filled green) side by side — three primaries
competing for one glance, which no other lane does.

Scope the demotion to this lane only. One line in `render()`:

```js
els.content.dataset.view = state.view;   // beside els.content.innerHTML = …, app.js:2048
```

```css
/* In this lane the branch being behind is the thing to fix first, so Update branch is the
   single filled control and everything else steps back to outline. Merge keeps its green
   and its disabled logic — only its weight changes. */
[data-view="behind"] .merge-button:not(:disabled),
[data-view="behind"] .rerun-button:not(:disabled) {
  background: transparent;
}
[data-view="behind"] .merge-button:not(:disabled) { color: var(--green); border-color: var(--green); }
[data-view="behind"] .rerun-button:not(:disabled) { color: var(--blue);  border-color: var(--blue);  }
[data-view="behind"] .merge-button:not(:disabled):hover { background: var(--green); color: var(--paper-strong); }
[data-view="behind"] .rerun-button:not(:disabled):hover { background: var(--blue);  color: var(--paper-strong); }
```

Resulting row, left to right: `[Update branch]` filled · `[Merge]` outline green ·
`[Close]` outline red · `[Open PR]` outline ink · dismiss.

## 6. Row treatment

Do **not** add a `.row-behind` background tint. `.row-conflict` tints because a conflict is an
error state; being behind is routine, and in an active repo most of the lane would be tinted,
which would make the tint meaningless and the lane loud. The rail item, the pill and the
button carry the signal.

## 7. Accessibility checklist

- [ ] Button has a text label, not icon-only; the icon is `aria-hidden="true"`.
- [ ] `aria-label` names the repo and PR number, so the control is distinguishable out of
      context in a screen-reader control list, matching merge and close.
- [ ] `title` explains the action in plain words; it supplements the label, never replaces it.
- [ ] Focus ring added to the shared `:focus-visible` group — 2px `--ink`, 2px offset.
- [ ] Disabled states carry `disabled`, so they leave the tab order and are announced.
- [ ] Every pair listed in the contrast table is ≥4.5:1 in both themes.
- [ ] The rail dot difference is a *shape* change, not colour alone (WCAG 1.4.1).
- [ ] Button min-height stays 28px, inherited from the shared selector; the row is a
      pointer-first desktop surface, unchanged from the existing action buttons.
- [ ] Long `baseRefName` truncates in the pill and does not cause horizontal overflow at
      1280px.
- [ ] Reduced motion: the spinner is neutralised by the existing global rule; no new
      animation is introduced.
- [ ] New: an axe-core pass over this view, in both themes. None exists in the repo today —
      `axe-core` is a declared but unused devDependency.
