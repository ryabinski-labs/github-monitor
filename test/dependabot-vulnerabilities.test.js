// Server-side rules for the Dependabot vulnerability view: what counts as one
// of the alerts the operator asked for, how a denied read is explained, and the
// order the projects appear in.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEPENDABOT_ALERTS_CACHE_TTL_MS,
  compareDependabotRows,
  dependabotRepoUrl,
  dependabotUncheckedReason,
  nextLinkCursor,
  summarizeDependabotAlerts
} from "../server.js";

function alert(overrides = {}) {
  return {
    number: 1,
    state: "open",
    created_at: "2026-09-01T00:00:00Z",
    security_vulnerability: { severity: "critical" },
    ...overrides
  };
}

test("summarizeDependabotAlerts counts open critical and high alerts and finds the oldest", () => {
  const summary = summarizeDependabotAlerts([
    alert({ created_at: "2026-09-10T00:00:00Z", security_vulnerability: { severity: "high" } }),
    alert({ created_at: "2026-08-01T00:00:00Z", security_vulnerability: { severity: "critical" } }),
    alert({ number: 3, security_vulnerability: { severity: "medium" } }),
    alert({ number: 4, state: "dismissed", security_vulnerability: { severity: "critical" } }),
    alert({ number: 5, state: "fixed", security_vulnerability: { severity: "high" } })
  ]);

  assert.deepEqual(summary, {
    critical: 1,
    high: 1,
    oldestAt: "2026-08-01T00:00:00Z"
  });
});

test("summarizeDependabotAlerts falls back to the advisory severity", () => {
  const summary = summarizeDependabotAlerts([
    alert({ security_vulnerability: undefined, security_advisory: { severity: "high" } })
  ]);
  assert.equal(summary.high, 1);
  assert.equal(summary.critical, 0);
});

test("dependabotUncheckedReason names the missing permission without leaking a token", () => {
  const reason = dependabotUncheckedReason(new Error("Resource not accessible by integration"));
  assert.match(reason, /Resource not accessible by integration/);

  const forbidden = dependabotUncheckedReason(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
  assert.match(forbidden, /Dependabot alerts: Read/);
  assert.match(forbidden, /security_events/);

  const disabled = dependabotUncheckedReason(Object.assign(new Error("Dependabot alerts are disabled for this repository."), { status: 403 }));
  assert.equal(disabled, "Dependabot alerts are disabled for this repository.");

  assert.equal(
    dependabotUncheckedReason(Object.assign(new Error("Not Found"), { status: 404 })),
    "Dependabot alerts are not available for this repository."
  );
});

test("nextLinkCursor reads only the rel=next cursor from GitHub's Link header", () => {
  assert.equal(
    nextLinkCursor('<https://api.github.com/repos/acme/app/dependabot/alerts?after=Y3Vyc29y>; rel="next", <https://api.github.com/repos/acme/app/dependabot/alerts?before=abc>; rel="prev"'),
    "Y3Vyc29y"
  );
  assert.equal(nextLinkCursor('<https://api.github.com/repos/acme/app/dependabot/alerts?before=abc>; rel="prev"'), "");
  assert.equal(nextLinkCursor(""), "");
  assert.equal(nextLinkCursor("not a link header"), "");
});

test("dependabotRepoUrl points at the repository's alert page", () => {
  assert.equal(
    dependabotRepoUrl("ryabinski-labs/github-monitor"),
    "https://github.com/ryabinski-labs/github-monitor/security/dependabot"
  );
});

test("compareDependabotRows puts the most critical and oldest projects first", () => {
  const rows = [
    { repo: "b/high", critical: 0, high: 4, oldestAt: "2026-09-01T00:00:00Z" },
    { repo: "a/critical", critical: 2, high: 1, oldestAt: "2026-08-15T00:00:00Z" },
    { repo: "c/critical", critical: 2, high: 1, oldestAt: "2026-08-01T00:00:00Z" },
    { repo: "d/critical", critical: 1, high: 9, oldestAt: "2026-07-01T00:00:00Z" }
  ].sort(compareDependabotRows);

  assert.deepEqual(rows.map((row) => row.repo), [
    "c/critical",
    "a/critical",
    "d/critical",
    "b/high"
  ]);
});

test("the alert cache is six hours, not the dashboard refresh interval", () => {
  assert.equal(DEPENDABOT_ALERTS_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
});
