// Auto-merge used to merge every green pull request in the watched orgs within
// minutes. Nothing distinguished a dependabot bump from an infrastructure
// change, so a memory/scheduling change merged itself the moment CI passed and
// then timed out in production. The gate is a label: a PR opts in, or it is a
// dependabot update that is already scoped to one dependency.
//
// These run against the real server so they cover the persisted setting and the
// snapshot a dashboard reads, not just the predicate in isolation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateDir = mkdtempSync(path.join(tmpdir(), "auto-merge-label-"));
const statePath = path.join(stateDir, "auto-merge.json");
process.env.AUTO_MERGE_STATE_PATH = statePath;
process.env.GITHUB_APP_ID = "";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";

const { server, isAutoMergeCandidate } = await import("../server.js");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

async function withServer(fn) {
  const listener = await new Promise((resolve) => {
    const started = server.listen(0, "127.0.0.1", () => resolve(started));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

async function setOptions(base, options) {
  const response = await fetch(`${base}/api/auto-merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, mode: "all", jobs: 4, ...options })
  });
  assert.equal(response.status, 200);
  return response.json();
}

function greenPr(overrides = {}) {
  return {
    state: "pass",
    checkCount: 2,
    isDraft: false,
    hasConflict: false,
    mergeable: "MERGEABLE",
    author: "cigan1",
    labels: [],
    ...overrides
  };
}

test("a green PR without the label is not a candidate", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    assert.equal(isAutoMergeCandidate(greenPr()), false);
  });
});

test("a green PR carrying the label is a candidate", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    assert.equal(isAutoMergeCandidate(greenPr({ labels: ["automerge"] })), true);
  });
});

test("the label match is case-insensitive", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    assert.equal(isAutoMergeCandidate(greenPr({ labels: ["AutoMerge"] })), true);
  });
});

test("dependabot updates still merge without a label", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    assert.equal(
      isAutoMergeCandidate(greenPr({ author: "dependabot[bot]" })),
      true
    );
  });
});

test("a missing check count still blocks a labelled PR", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    assert.equal(
      isAutoMergeCandidate(greenPr({ labels: ["automerge"], checkCount: 0, mergeable: "UNKNOWN" })),
      false
    );
  });
});

test("an empty requireLabel deliberately lifts the gate", async () => {
  await withServer(async (base) => {
    const snapshot = await setOptions(base, { requireLabel: "" });
    assert.equal(snapshot.requireLabel, "");
    assert.equal(isAutoMergeCandidate(greenPr()), true);
  });
});

test("the requirement is persisted and reported in the snapshot", async () => {
  await withServer(async (base) => {
    const snapshot = await setOptions(base, { requireLabel: "ship-it" });
    assert.equal(snapshot.requireLabel, "ship-it");

    const read = await (await fetch(`${base}/api/auto-merge`)).json();
    assert.equal(read.requireLabel, "ship-it");
    assert.equal(isAutoMergeCandidate(greenPr({ labels: ["ship-it"] })), true);
    assert.equal(isAutoMergeCandidate(greenPr({ labels: ["automerge"] })), false);
  });
});
