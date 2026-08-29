import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_MODE, buildDashboardWarnings, resolveAuthMode } from "../server.js";

// The GitHub App for this dashboard existed, with its private key on disk, from
// May to August 2026 while every scan quietly ran on a personal access token --
// because falling back was silent and nothing ever said which credential was in
// use. These tests exist so that cannot happen again unnoticed.

test("app auth needs both halves, and half of it is a misconfiguration", () => {
  assert.deepEqual(resolveAuthMode({ appId: "3829432", privateKeyPath: "/keys/app.pem" }), {
    mode: "app",
    appId: "3829432",
    misconfigured: false
  });

  // An id with no key cannot mint a JWT. It is not half-working app auth; it is
  // the PAT path wearing a misleading config, which is the trap worth naming.
  assert.deepEqual(resolveAuthMode({ appId: "3829432", privateKeyPath: "" }), {
    mode: "pat",
    appId: null,
    misconfigured: true
  });
  assert.deepEqual(resolveAuthMode({ appId: "", privateKeyPath: "/keys/app.pem" }), {
    mode: "pat",
    appId: null,
    misconfigured: true
  });

  // Neither set is a deliberate PAT setup, not a mistake.
  assert.deepEqual(resolveAuthMode({ appId: "", privateKeyPath: "" }), {
    mode: "pat",
    appId: null,
    misconfigured: false
  });
  assert.deepEqual(resolveAuthMode({}), { mode: "pat", appId: null, misconfigured: false });
});

test("running on a personal access token is stated on the dashboard, not left silent", () => {
  const rateLimit = { tightest: null, buckets: [] };
  const summary = { finishedCd: 0 };
  const warnings = buildDashboardWarnings(rateLimit, summary, { mode: "all", includeCd: true });

  if (AUTH_MODE.mode === "pat") {
    assert.ok(
      warnings.some((warning) => /personal access token/i.test(warning)),
      `expected a PAT warning, got: ${JSON.stringify(warnings)}`
    );
    assert.ok(
      warnings.some((warning) => /5,000 requests\/hour/.test(warning)),
      "the warning names the limit that makes this matter"
    );
  } else {
    // Under app auth the warning must be absent, or it becomes noise that
    // teaches everyone to ignore it.
    assert.ok(
      !warnings.some((warning) => /personal access token/i.test(warning)),
      `expected no PAT warning under app auth, got: ${JSON.stringify(warnings)}`
    );
  }
});

test("a half-configured app is called out specifically, not as a plain PAT", () => {
  // Exercised through the resolver rather than the module-level constant, which
  // is fixed at import time by the environment the tests happen to run in.
  const half = resolveAuthMode({ appId: "3829432", privateKeyPath: "" });
  assert.equal(half.misconfigured, true);
  assert.equal(half.mode, "pat");
  // Someone who set one variable meant to use the app; the warning has to say
  // that, not just report the PAT it silently fell back to.
  const complete = resolveAuthMode({ appId: "3829432", privateKeyPath: "/keys/app.pem" });
  assert.equal(complete.misconfigured, false);
});

test("the resolved mode is reported, so a silent fallback is visible", () => {
  assert.ok(["app", "pat"].includes(AUTH_MODE.mode));
  assert.equal(typeof AUTH_MODE.misconfigured, "boolean");
  // appId is present exactly when app auth is live.
  if (AUTH_MODE.mode === "app") assert.ok(AUTH_MODE.appId, "app mode carries the id it authenticates as");
  else assert.equal(AUTH_MODE.appId, null);
});

// server.js loads .env at import. Under the test runner that made the suite
// depend on the developer's machine: enabling GitHub App auth in .env silently
// rerouted every test that stubs fetch, and the suite stayed green in CI (which
// has no .env) while failing locally. This pins the isolation.
test("the test runner does not inherit the developer's .env", async () => {
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const envFile = path.join(root, ".env");
  if (!existsSync(envFile)) return; // Nothing to leak; CI takes this branch.

  const probe = "import('./server.js').then(() => console.log(JSON.stringify({ jobs: process.env.OPEN_PRS_JOBS ?? null, appId: process.env.GITHUB_APP_ID ?? null })))";
  const run = (env) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: env, OPEN_PRS_JOBS: "", GITHUB_APP_ID: "" }
  }).stdout.trim() || "{}");

  const underTest = run("test");
  assert.equal(underTest.jobs, "", "OPEN_PRS_JOBS from .env did not leak into a test run");
  assert.equal(underTest.appId, "", "GITHUB_APP_ID from .env did not leak into a test run");
});
