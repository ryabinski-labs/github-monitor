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

const { server, isAutoMergeCandidate, autoMergeState } = await import("../server.js");

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
    // The PR search uses GraphQL, where author.login is "dependabot" (REST
    // reports "dependabot[bot]" and gh prints "app/dependabot").
    for (const author of ["dependabot", "dependabot[bot]", "app/dependabot"]) {
      assert.equal(
        isAutoMergeCandidate(greenPr({ author })),
        true,
        `${author} should not need the label`
      );
    }
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

test("only a clean, up-to-date, mergeable build is a candidate", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    const ready = { labels: ["automerge"] };
    assert.equal(isAutoMergeCandidate(greenPr(ready)), true);
    assert.equal(isAutoMergeCandidate(greenPr({ ...ready, behindBy: 3 })), false);
    assert.equal(isAutoMergeCandidate(greenPr({ ...ready, isArchived: true })), false);
    assert.equal(isAutoMergeCandidate(greenPr({ ...ready, mergeable: "UNKNOWN" })), false);
    assert.equal(isAutoMergeCandidate(greenPr({ ...ready, awaitingApprovalCount: 1 })), false);
  });
});

test("a merge GitHub rejected stays parked until the head changes", async () => {
  await withServer(async (base) => {
    await setOptions(base, { requireLabel: "automerge" });
    const pr = greenPr({
      repo: "acme/app",
      number: 7,
      headSha: "aaa",
      labels: ["automerge"]
    });
    try {
      autoMergeState.rejected.set("acme/app#7", {
        repo: pr.repo,
        number: pr.number,
        numberLabel: "#7",
        title: "test",
        url: "https://github.com/acme/app/pull/7",
        headSha: pr.headSha,
        error: "Merge commits are not allowed on this repository.",
        at: new Date().toISOString()
      });
      assert.equal(isAutoMergeCandidate(pr), false);
      assert.equal(isAutoMergeCandidate({ ...pr, headSha: "bbb" }), true);

      const snapshot = await (await fetch(`${base}/api/auto-merge`)).json();
      assert.equal(snapshot.rejected.length, 1);
      assert.equal(snapshot.rejected[0].number, 7);
      assert.match(snapshot.rejected[0].error, /Merge commits are not allowed/);
    } finally {
      autoMergeState.rejected.clear();
    }
  });
});

test("an empty requireLabel deliberately lifts the gate", async () => {
  await withServer(async (base) => {
    const snapshot = await setOptions(base, { requireLabel: "" });
    assert.equal(snapshot.requireLabel, "");
    assert.equal(isAutoMergeCandidate(greenPr()), true);

    // The dashboard sends enabled/mode/jobs/owners without requireLabel. That
    // must not quietly re-arm the gate on the next toggle.
    const toggled = await setOptions(base, {});
    assert.equal(toggled.requireLabel, "");
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
