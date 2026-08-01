import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  SECURITY_HEADERS,
  bestProductionUrlCandidate,
  buildChangeSummary,
  classifyPullRequest,
  extractProductionUrlsFromText,
  groupPullRequests,
  applyActionRunEvidenceToPullRequests,
  isProductionTargetScanPath,
  productionTargetFromCodeFiles,
  isAutoMergeCandidate,
  mergeBlockReason,
  openPullRequestSearchQuery,
  quotaState,
  recordRateLimit,
  snapshotRateLimit,
  resetObservedRateBuckets,
  createScanMetrics,
  scanMetrics,
  recommendRefresh,
  publicRouteFromFile,
  isBackendUrl,
  runOutcome,
  buildPipelineTraces,
  isDeployNeutralFile,
  mergedPrIsDeployNeutral,
  selectFailedActionRuns,
  selectFailedCdRuns,
  findSupersedingSuccessfulRun,
  applyConditionalHeaders,
  takeCachedConditionalResponse,
  storeConditionalResponse,
  extractOwnerFromPath,
  buildAppJwtPayload,
  signAppJwt,
  installationTokenIsValid,
  parseDependabotQueueThreshold,
  isDependabotLogin,
  isDependabotWorkflowRun,
  dependabotQueueDepth,
  shouldCleanDependabotQueue,
  markAutoDismissedDependabotRuns,
  hasFailedCiSignal,
  cleanupDependabotWorkload,
  runDependabotQueueScan,
  resetDependabotCleanupState,
  server
} from "../server.js";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("conflicted pull requests are excluded from CI status buckets", () => {
  const groups = groupPullRequests([
    { repo: "owner/a", number: 1, state: "pass", checkCount: 2, hasConflict: false },
    { repo: "owner/a", number: 2, state: "pass", checkCount: 2, hasConflict: true },
    { repo: "owner/a", number: 3, state: "fail", checkCount: 2, hasConflict: true },
    { repo: "owner/a", number: 4, state: "running", checkCount: 2, hasConflict: true }
  ]);

  assert.deepEqual(groups.pass.map((pr) => pr.number), [1]);
  assert.deepEqual(groups.fail.map((pr) => pr.number), []);
  assert.deepEqual(groups.running.map((pr) => pr.number), []);
  assert.deepEqual(groups.conflicts.map((pr) => pr.number), [2, 3, 4]);
});

test("ready pull requests without CI are listed separately from passing CI", () => {
  const groups = groupPullRequests([
    { repo: "owner/a", number: 1, state: "pass", checkCount: 2, isDraft: false, hasConflict: false },
    { repo: "owner/a", number: 2, state: "pass", checkCount: 0, isDraft: false, hasConflict: false },
    { repo: "owner/a", number: 3, state: "pass", checkCount: 0, isDraft: true, hasConflict: false },
    { repo: "owner/a", number: 4, state: "pass", checkCount: 0, isDraft: false, hasConflict: true }
  ]);

  assert.deepEqual(groups.pass.map((pr) => pr.number), [1]);
  assert.deepEqual(groups.noCi.map((pr) => pr.number), [2]);
  assert.deepEqual(groups.conflicts.map((pr) => pr.number), [4]);
});

test("pull requests without CI are classified instead of dropped", () => {
  const pr = classifyPullRequest({
    number: 12,
    title: "Docs update",
    url: "https://github.com/owner/a/pull/12",
    isDraft: false,
    mergeable: "MERGEABLE",
    author: { login: "dev" },
    repository: { nameWithOwner: "owner/a", isArchived: false },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: []
              }
            }
          }
        }
      ]
    }
  });

  assert.equal(pr.state, "pass");
  assert.equal(pr.checkCount, 0);
  assert.equal(pr.hasConflict, false);
});

test("running Actions evidence moves PRs out of the no-CI bucket", () => {
  const [pr] = applyActionRunEvidenceToPullRequests(
    [
      {
        repo: "GipsyChef/alaskaroadtrip-business",
        number: 297,
        numberLabel: "#297",
        title: "SEO recommendations",
        state: "pass",
        checkCount: 0,
        hasConflict: false,
        headSha: "abc123"
      }
    ],
    {
      runningActions: [
        {
          kind: "workflowRun",
          repo: "GipsyChef/alaskaroadtrip-business",
          workflow: "CI",
          runNumber: "#370",
          status: "in_progress",
          headSha: "abc123",
          pullRequestNumbers: [297]
        }
      ]
    }
  );

  assert.equal(pr.state, "running");
  assert.equal(pr.checkCount, 1);
  assert.deepEqual(pr.runningChecks, ["CI #370 [in_progress]"]);

  const groups = groupPullRequests([pr]);
  assert.deepEqual(groups.noCi, []);
  assert.deepEqual(groups.running.map((row) => row.number), [297]);
});

test("pull request classification carries archived repo state", () => {
  const pr = classifyPullRequest({
    number: 13,
    title: "Archived repo update",
    url: "https://github.com/owner/old/pull/13",
    isDraft: false,
    mergeable: "MERGEABLE",
    author: { login: "dev" },
    repository: { nameWithOwner: "owner/old", isArchived: true },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: []
              }
            }
          }
        }
      ]
    }
  });

  assert.equal(pr.isArchived, true);
});

test("no-CI pull requests must be mergeable before merging", () => {
  assert.equal(
    mergeBlockReason({
      state: "pass",
      checkCount: 0,
      isDraft: false,
      hasConflict: false,
      mergeable: "MERGEABLE"
    }),
    ""
  );
  assert.equal(
    mergeBlockReason({
      state: "pass",
      checkCount: 0,
      isDraft: false,
      hasConflict: false,
      mergeable: "UNKNOWN"
    }),
    "This pull request is not currently mergeable."
  );
});

test("auto merge only targets passing pull requests with reported checks", () => {
  assert.equal(
    isAutoMergeCandidate({
      state: "pass",
      checkCount: 1,
      isDraft: false,
      hasConflict: false,
      mergeable: "MERGEABLE"
    }),
    true
  );
  assert.equal(
    isAutoMergeCandidate({
      state: "pass",
      checkCount: 0,
      isDraft: false,
      hasConflict: false,
      mergeable: "MERGEABLE"
    }),
    false
  );
});

test("open pull request searches exclude archived repositories", () => {
  assert.equal(openPullRequestSearchQuery("owner", "dev"), "is:pr state:open archived:false owner:dev");
  assert.equal(openPullRequestSearchQuery("author", "dev"), "is:pr state:open archived:false author:dev");
});

test("deep queue threshold is configurable and can be disabled", () => {
  assert.equal(parseDependabotQueueThreshold(undefined), 0);
  assert.equal(parseDependabotQueueThreshold("35"), 35);
  assert.equal(parseDependabotQueueThreshold("0"), 0);
  assert.equal(parseDependabotQueueThreshold("invalid"), 0);
  assert.equal(parseDependabotQueueThreshold("5001"), 0);
  assert.equal(shouldCleanDependabotQueue(19, 20), false);
  assert.equal(shouldCleanDependabotQueue(20, 20), true);
  assert.equal(shouldCleanDependabotQueue(100, 0), false);
});

test("Dependabot workflow detection is exact and queue depth deduplicates runs", () => {
  assert.equal(isDependabotLogin("dependabot[bot]"), true);
  assert.equal(isDependabotLogin("Dependabot[bot]"), true);
  assert.equal(isDependabotLogin("dependabot-preview[bot]"), false);
  assert.equal(isDependabotWorkflowRun({ actor: { login: "dependabot[bot]" } }), true);
  assert.equal(isDependabotWorkflowRun({ triggering_actor: { login: "dependabot[bot]" } }), true);
  assert.equal(isDependabotWorkflowRun({ actor: { login: "maintainer" } }), false);
  assert.equal(dependabotQueueDepth([
    { repo: "acme/app", runId: 1, status: "queued" },
    { repo: "acme/app", runId: 1, status: "queued" },
    { repo: "acme/app", runId: 2, status: "in_progress" },
    { repo: "acme/app", runId: 3, status: "completed" }
  ]), 1);
});

test("failed Dependabot runs arrive pre-dismissed only when cleanup is enabled", () => {
  const runs = [
    { kind: "workflowRun", repo: "acme/app", runNumber: "#13", dependabot: true, conclusion: "failure" },
    { kind: "workflowRun", repo: "acme/app", runNumber: "#14", conclusion: "failure" }
  ];

  const disabled = markAutoDismissedDependabotRuns(runs, { enabled: false });
  assert.equal(disabled[0].autoDismissed, undefined);
  assert.equal(disabled[1].autoDismissed, undefined);

  const enabled = markAutoDismissedDependabotRuns(runs, { enabled: true });
  assert.equal(enabled[0].autoDismissed, true);
  assert.match(enabled[0].autoDismissReason, /Dependabot/);
  assert.equal(enabled[1].autoDismissed, undefined);
  // The caller's rows are never mutated in place.
  assert.equal(runs[0].autoDismissed, undefined);
  assert.deepEqual(markAutoDismissedDependabotRuns(undefined, { enabled: true }), []);
});

test("refresh recommendations pause when GitHub API quota is low", () => {
  const resetAt = new Date(Date.now() + 18 * 60 * 1000).toISOString();
  const rateLimit = {
    tightest: {
      resource: "core",
      remaining: 120,
      limit: 5000,
      resetAt
    }
  };

  const quota = quotaState(rateLimit);
  assert.equal(quota.status, "low");
  assert.equal(quota.blocked, true);

  const refresh = recommendRefresh(
    {
      runningPrs: 0,
      runningCd: 0,
      runningDeployments: 0,
      busyRunners: 0,
      failingPrs: 0,
      failedCd: 0
    },
    {
      mode: "all",
      includeCd: true,
      includeRepoRunners: false
    },
    rateLimit
  );

  assert.equal(refresh.quota.blocked, true);
  assert.equal(refresh.quota.resource, "core");
  assert.match(refresh.reason, /Paused for core API quota/);
  assert.ok(new Date(refresh.nextRefreshAt).getTime() >= new Date(resetAt).getTime());
});

test("a half-full small per-minute bucket (Search 15/30) does not pause refresh", () => {
  // The Search secondary limit is 30/min. At 15/30 it is half-full and refills
  // in ~60s — the absolute `remaining < 200` floor must not apply to it.
  const resetAt = new Date(Date.now() + 45 * 1000).toISOString();
  const quota = quotaState({
    tightest: { resource: "search", remaining: 15, limit: 30, resetAt }
  });
  assert.equal(quota.blocked, false);
  assert.equal(quota.status, "ok");
});

test("a nearly-exhausted small bucket still blocks by ratio", () => {
  const resetAt = new Date(Date.now() + 30 * 1000).toISOString();
  const quota = quotaState({
    tightest: { resource: "search", remaining: 3, limit: 30, resetAt }
  });
  assert.equal(quota.blocked, true);
  assert.equal(quota.status, "low");
});

test("production target scan finds deployable URLs in project code", () => {
  assert.equal(isProductionTargetScanPath("infra/cdk/app-stack.ts"), true);
  assert.equal(isProductionTargetScanPath("src/components/Button.tsx"), false);
  assert.deepEqual(
    extractProductionUrlsFromText("SITE_URL=https://safespendplan.com\nconst docs = 'https://docs.aws.amazon.com/foo'"),
    ["https://safespendplan.com", "https://docs.aws.amazon.com/foo"]
  );

  const best = bestProductionUrlCandidate([
    { url: "https://docs.aws.amazon.com/cloudfront/", source: "infra/README.md" },
    { url: "https://d111111abcdef8.cloudfront.net", source: "infra/cdk/app-stack.ts" },
    { url: "safespendplan-market-refresh.json", source: "infra/cdk/outputs.json" },
    { url: "deploy-frontend-stack.sh", source: "scripts/deploy.sh" },
    { url: "seo.sitemap", source: "public/sitemap.xml" },
    { url: "https://$api_domain", source: "scripts/deploy.sh" },
    { url: "certificate.domainvalidationoptions", source: "infra/cdk/app-stack.ts" },
    { url: "https://cloudfront.amazonaws.com", source: "infra/README.md" },
    { url: "https://webemail.local", source: "README.md" },
    { url: "safespendplan.com", source: "infra/cdk/app-stack.ts" },
    { url: "http://localhost:3000", source: "README.md" }
  ], "GipsyChef/safespendplan");

  assert.equal(best.url, "https://safespendplan.com/");
  assert.equal(best.source, "infra/cdk/app-stack.ts");
});

test("productionTargetFromCodeFiles honors source precedence", () => {
  // package.json homepage wins over everything else.
  assert.deepEqual(
    productionTargetFromCodeFiles({
      "package.json": JSON.stringify({ homepage: "https://app.safespendplan.com" }),
      CNAME: "fallback.acme-app.io",
      "vercel.json": JSON.stringify({ url: "https://nope.acme-app.io" })
    }),
    { url: "https://app.safespendplan.com/", environment: "production", source: "package.json homepage" }
  );

  // CNAME wins over framework config when no package.json homepage.
  assert.deepEqual(
    productionTargetFromCodeFiles({
      "package.json": JSON.stringify({ name: "x" }),
      "public/CNAME": "site.acme-app.io",
      "netlify.toml": "url = \"https://other.acme-app.io\""
    }),
    { url: "https://site.acme-app.io/", environment: "production", source: "public/CNAME" }
  );

  // Falls through to a framework config file when nothing higher matches.
  const fromConfig = productionTargetFromCodeFiles({
    "next.config.js": "module.exports = { env: { SITE: 'https://prod.acme-app.io' } }"
  });
  assert.equal(fromConfig.source, "next.config.js");
  assert.equal(fromConfig.environment, "production");

  // No signal anywhere → empty result (no URL fabricated).
  assert.deepEqual(productionTargetFromCodeFiles({ "package.json": "{}" }), {});
  assert.deepEqual(productionTargetFromCodeFiles({}), {});
});

test("finished CD change summaries infer reviewable page links and cues", () => {
  assert.equal(publicRouteFromFile("app/settings/billing/page.tsx"), "/settings/billing");
  assert.equal(publicRouteFromFile("src/pages/docs/[slug].tsx"), "/docs/:slug");
  assert.equal(publicRouteFromFile("public/changelog.html"), "/changelog.html");
  assert.equal(publicRouteFromFile("pages/api/health.ts"), "");

  const summary = buildChangeSummary(
    "acme/app",
    {
      head_sha: "abcdef1234567890",
      display_title: "ship billing settings"
    },
    {
      sha: "abcdef1234567890",
      html_url: "https://github.com/acme/app/commit/abcdef1",
      stats: { additions: 18, deletions: 4 },
      commit: {
        message: "Improve billing settings\n\nBody",
        author: { name: "Dev" }
      },
      files: [
        {
          filename: "app/settings/billing/page.tsx",
          status: "modified",
          additions: 10,
          deletions: 2,
          changes: 12,
          blob_url: "https://github.com/acme/app/blob/abcdef1/app/settings/billing/page.tsx"
        },
        {
          filename: "app/settings/billing/styles.css",
          status: "modified",
          additions: 8,
          deletions: 2,
          changes: 10,
          blob_url: "https://github.com/acme/app/blob/abcdef1/app/settings/billing/styles.css"
        }
      ]
    },
    { url: "https://app.example.com", environment: "production" },
    {
      mergedPullRequests: [
        {
          pr: {
            number: 42,
            title: "Add billing summary",
            user: { login: "dev" },
            merged_at: "2026-05-20T10:00:00Z",
            html_url: "https://github.com/acme/app/pull/42"
          },
          files: [
            {
              filename: "app/settings/billing/page.tsx",
              status: "modified",
              additions: 5,
              deletions: 1,
              blob_url: "https://github.com/acme/app/blob/abcdef1/app/settings/billing/page.tsx"
            }
          ]
        }
      ]
    }
  );

  assert.equal(summary.shortSha, "abcdef1");
  assert.equal(summary.source, "commit");
  assert.equal(summary.filesChanged, 2);
  assert.equal(summary.message, "Improve billing settings");
  assert.equal(summary.changedPages.length, 1);
  assert.equal(summary.changedPages[0].url, "https://app.example.com/settings/billing");
  assert.match(summary.changedPages[0].lookFor, /rendered page/);
  assert.match(summary.changedFiles[1].lookFor, /Visual styling/);
  assert.equal(summary.mergedPullRequests.length, 1);
  assert.equal(summary.mergedPullRequests[0].numberLabel, "#42");
  assert.equal(summary.mergedPullRequests[0].changedPages[0].url, "https://app.example.com/settings/billing");

  const compareSummary = buildChangeSummary(
    "acme/app",
    {
      head_sha: "2222222222222222",
      display_title: "deploy multiple commits"
    },
    {
      html_url: "https://github.com/acme/app/compare/1111111...2222222",
      total_commits: 2,
      commits: [
        { commit: { message: "First", author: { name: "Dev" } } },
        { commit: { message: "Second", author: { name: "Dev" } } }
      ],
      files: [
        {
          filename: "app/page.tsx",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          blob_url: "https://github.com/acme/app/blob/2222222/app/page.tsx"
        }
      ]
    },
    { url: "https://app.example.com" },
    { source: "compare", baseSha: "1111111111111111" }
  );

  assert.equal(compareSummary.source, "compare");
  assert.equal(compareSummary.sourceLabel, "1111111...2222222");
  assert.equal(compareSummary.commitCount, 2);
  assert.equal(compareSummary.additions, 3);
  assert.equal(compareSummary.deletions, 1);
  assert.match(compareSummary.lookFor, /previous completed CD run/);

  const commitFallback = buildChangeSummary(
    "acme/app",
    {
      display_title: "deploy without diff",
      head_branch: "main"
    },
    null,
    { url: "https://app.example.com" },
    {
      recentCommits: [
        {
          sha: "3333333333333333",
          html_url: "https://github.com/acme/app/commit/3333333",
          commit: {
            message: "Ship homepage copy",
            author: { name: "Dev", date: "2026-05-20T12:00:00Z" }
          },
          files: [
            {
              filename: "app/page.tsx",
              status: "modified",
              additions: 4,
              deletions: 1,
              blob_url: "https://github.com/acme/app/blob/3333333/app/page.tsx"
            }
          ]
        }
      ]
    }
  );

  assert.equal(commitFallback.filesChanged, 0);
  assert.equal(commitFallback.recentCommits.length, 1);
  assert.equal(commitFallback.recentCommits[0].shortSha, "3333333");
  assert.equal(commitFallback.recentCommits[0].changedPages[0].url, "https://app.example.com/");
  assert.equal(commitFallback.reviewLinks.commitsUrl, "https://github.com/acme/app/commits/main");
  assert.match(commitFallback.lookFor, /recent commit summary/);

  const homepageTarget = buildChangeSummary(
    "acme/app",
    {
      display_title: "homepage deploy",
      head_branch: "main"
    },
    null,
    { url: "https://prod.example.com", environment: "production" },
    {
      mergedPullRequests: [
        {
          pr: {
            number: 7,
            title: "Change dashboard",
            user: { login: "dev" },
            merged_at: "2026-05-20T12:00:00Z",
            html_url: "https://github.com/acme/app/pull/7"
          },
          files: [
            {
              filename: "pages/dashboard.tsx",
              status: "modified",
              additions: 5,
              deletions: 1,
              blob_url: "https://github.com/acme/app/blob/head/pages/dashboard.tsx"
            }
          ]
        }
      ]
    }
  );

  assert.equal(homepageTarget.deployUrl, "https://prod.example.com");
  assert.equal(homepageTarget.mergedPullRequests[0].changedPages[0].url, "https://prod.example.com/dashboard");

  const inferredTarget = buildChangeSummary(
    "GipsyChef/safespendplan",
    {
      display_title: "deploy security fixes",
      head_branch: "main"
    },
    null,
    { url: "https://safespendplan.com/", environment: "production" },
    {
      mergedPullRequests: [
        {
          pr: {
            number: 118,
            title: "security: fix forgeable JWT key, magic-link race, plan IDOR",
            user: { login: "cigan1" },
            merged_at: "2026-05-20T12:00:00Z",
            html_url: "https://github.com/GipsyChef/safespendplan/pull/118"
          },
          files: [
            {
              filename: "src/auth/magic-link.ts",
              status: "modified",
              additions: 20,
              deletions: 4,
              blob_url: "https://github.com/GipsyChef/safespendplan/blob/head/src/auth/magic-link.ts"
            }
          ]
        }
      ]
    }
  );

  assert.equal(inferredTarget.mergedPullRequests[0].changedPages[0].url, "https://safespendplan.com/login");
  assert.equal(inferredTarget.mergedPullRequests[0].inferredPages, true);
});

test("page shell keeps accessible heading and button group semantics", () => {
  assert.match(indexHtml, /<h1 class="brand-name">PR Command Deck<\/h1>/);
  assert.doesNotMatch(indexHtml, /role="tablist"/);
  assert.match(indexHtml, /class="segmented" role="group" aria-label="Scope"/);
  assert.match(indexHtml, /data-mode="all" aria-pressed="true"/);
  assert.doesNotMatch(indexHtml, /class="grain"/);
});

test("page shell avoids external preconnect metadata links", () => {
  assert.doesNotMatch(indexHtml, /rel="preconnect"/);
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com/);
  assert.doesNotMatch(indexHtml, /fonts\.gstatic\.com/);
});

test("security headers restrict privileged local dashboard surfaces", () => {
  assert.match(SECURITY_HEADERS["content-security-policy"], /default-src 'self'/);
  assert.match(SECURITY_HEADERS["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(SECURITY_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(SECURITY_HEADERS["referrer-policy"], "no-referrer");
});

test("runner status endpoint returns only busy runners", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": requestUrl.pathname === "/graphql" ? "graphql" : "core"
    };

    if (requestUrl.pathname === "/user") {
      return Response.json({ login: "maintainer" }, { headers });
    }
    if (requestUrl.pathname === "/user/orgs") {
      return Response.json([{ login: "acme" }], { headers });
    }
    if (requestUrl.pathname === "/graphql") {
      assert.match(body.variables.q, /is:pr state:open archived:false owner:/);
      return Response.json({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }, { headers });
    }
    if (requestUrl.pathname === "/orgs/acme/actions/runners") {
      return Response.json({
        runners: [
          {
            name: "busy-linux",
            status: "online",
            busy: true,
            labels: [{ name: "self-hosted" }, { name: "linux" }]
          },
          {
            name: "idle-linux",
            status: "online",
            busy: false,
            labels: [{ name: "self-hosted" }]
          }
        ]
      }, { headers });
    }
    if (requestUrl.pathname === "/orgs/maintainer/actions/runners") {
      return Response.json({ runners: [] }, { headers });
    }

    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await previousFetch(`http://127.0.0.1:${port}/api/runners/status?mode=all&jobs=1`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.summary.busyRunners, 1);
    assert.deepEqual(data.runners.busy, [
      {
        level: "ORG",
        scope: "acme",
        name: "busy-linux",
        status: "online",
        labels: ["self-hosted", "linux"]
      }
    ]);
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("dashboard includes running non-CD workflow runs in CI running work", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": requestUrl.pathname === "/graphql" ? "graphql" : "core"
    };

    if (requestUrl.pathname === "/user") {
      return Response.json({ login: "maintainer" }, { headers });
    }
    if (requestUrl.pathname === "/user/orgs") {
      return Response.json([{ login: "acme" }], { headers });
    }
    if (requestUrl.pathname === "/user/repos") {
      return Response.json([], { headers });
    }
    if (requestUrl.pathname === "/orgs/acme/repos") {
      return Response.json([
        { full_name: "acme/app", archived: false, owner: { login: "acme" } }
      ], { headers });
    }
    if (requestUrl.pathname === "/graphql") {
      assert.match(body.variables.q, /is:pr state:open archived:false owner:/);
      return Response.json({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }, { headers });
    }
    if (requestUrl.pathname === "/repos/acme/app/actions/runs") {
      return Response.json({
        workflow_runs: [
          {
            name: "ci-lambdas",
            path: ".github/workflows/ci-lambdas.yml",
            status: "in_progress",
            created_at: "2026-05-18T20:00:00Z",
            run_number: 42,
            head_branch: "feature",
            display_title: "test lambdas",
            html_url: "https://github.com/acme/app/actions/runs/42"
          },
          {
            id: 45,
            name: "ci",
            path: ".github/workflows/ci.yml",
            event: "push",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-05-18T20:03:00Z",
            updated_at: new Date().toISOString(),
            run_number: 45,
            head_branch: "main",
            display_title: "Merge pull request #12 from acme/fix",
            html_url: "https://github.com/acme/app/actions/runs/45"
          },
          {
            name: "Deploy",
            path: ".github/workflows/deploy.yml",
            status: "in_progress",
            created_at: "2026-05-18T20:01:00Z",
            run_number: 43,
            head_branch: "main",
            display_title: "deploy",
            html_url: "https://github.com/acme/app/actions/runs/43"
          },
          {
            name: "ci",
            path: ".github/workflows/ci.yml",
            status: "completed",
            created_at: "2026-05-18T20:02:00Z",
            run_number: 44,
            head_branch: "main",
            display_title: "done",
            html_url: "https://github.com/acme/app/actions/runs/44"
          }
        ]
      }, { headers });
    }
    if (requestUrl.pathname === "/repos/acme/app/actions/runs/45/jobs") {
      return Response.json({
        jobs: [
          { name: "engine — pytest", conclusion: "failure" }
        ]
      }, { headers });
    }

    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await previousFetch(`http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.summary.failingPrs, 1);
    assert.equal(data.summary.runningPrs, 1);
    assert.deepEqual(data.actions.failed, [
      {
        kind: "workflowRun",
        createdAt: data.actions.failed[0].createdAt,
        repo: "acme/app",
        workflow: "ci",
        runNumber: "#45",
        status: "completed",
        conclusion: "failure",
        branch: "main",
        title: "Merge pull request #12 from acme/fix",
        url: "https://github.com/acme/app/actions/runs/45",
        failureReason: "engine — pytest failed"
      }
    ]);
    assert.deepEqual(data.actions.running, [
      {
        kind: "workflowRun",
        createdAt: "2026-05-18T20:00:00Z",
        repo: "acme/app",
        workflow: "ci-lambdas",
        runNumber: "#42",
        status: "in_progress",
        branch: "feature",
        title: "test lambdas",
        url: "https://github.com/acme/app/actions/runs/42"
      }
    ]);
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("deep queue cleanup closes Dependabot PRs and cancels every active Dependabot run", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const mutations = [];

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": "core"
    };

    if (requestUrl.pathname === "/repos/deep-queue-fixture/app/pulls" && options.method === "GET") {
      return Response.json([
        { number: 7, title: "Bump runtime", html_url: "https://github.com/deep-queue-fixture/app/pull/7", user: { login: "dependabot[bot]" }, head: { sha: "sha7" } },
        { number: 8, title: "Human change", html_url: "https://github.com/deep-queue-fixture/app/pull/8", user: { login: "maintainer" }, head: { sha: "sha8" } }
      ], { headers });
    }
    // REST reports lowercase check-run status/conclusion, unlike the GraphQL enums.
    if (requestUrl.pathname === "/repos/deep-queue-fixture/app/commits/sha7/check-runs") {
      return Response.json({ check_runs: [{ status: "completed", conclusion: "failure" }] }, { headers });
    }
    if (requestUrl.pathname === "/repos/deep-queue-fixture/app/commits/sha7/status") {
      return Response.json({ statuses: [] }, { headers });
    }
    if (requestUrl.pathname === "/repos/deep-queue-fixture/app/actions/runs" && options.method === "GET") {
      const status = requestUrl.searchParams.get("status");
      const workflowRuns = status === "queued"
        ? [
            { id: 70, name: "CI", status, html_url: "https://github.com/deep-queue-fixture/app/actions/runs/70", actor: { login: "dependabot[bot]" } },
            { id: 71, name: "CI", status, html_url: "https://github.com/deep-queue-fixture/app/actions/runs/71", actor: { login: "maintainer" } }
          ]
        : status === "in_progress"
          ? [{ id: 72, name: "CodeQL", status, html_url: "https://github.com/deep-queue-fixture/app/actions/runs/72", triggering_actor: { login: "dependabot[bot]" } }]
          : [];
      return Response.json({ workflow_runs: workflowRuns }, { headers });
    }
    if (requestUrl.pathname === "/repos/deep-queue-fixture/app/pulls/7" && options.method === "PATCH") {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return Response.json({ state: "closed" }, { headers });
    }
    if (/\/repos\/deep-queue-fixture\/app\/actions\/runs\/(70|72)\/cancel/.test(requestUrl.pathname) && options.method === "POST") {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return new Response(null, { status: 202, headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  try {
    const result = await cleanupDependabotWorkload({ repos: ["deep-queue-fixture/app"], jobs: 2 });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closedPullRequests.map((pr) => pr.number), [7]);
    assert.deepEqual(result.cancelledRuns.map((run) => run.runId).sort(), [70, 72]);
    assert.deepEqual(mutations.sort(), [
      "PATCH /repos/deep-queue-fixture/app/pulls/7",
      "POST /repos/deep-queue-fixture/app/actions/runs/70/cancel",
      "POST /repos/deep-queue-fixture/app/actions/runs/72/cancel"
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("cleanup preserves successful discoveries when one active-status request fails", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const mutations = [];

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": "core"
    };
    if (requestUrl.pathname === "/repos/partial-cleanup-fixture/app/pulls" && options.method === "GET") {
      return Response.json([
        { number: 9, title: "Bump dependency", html_url: "https://github.com/partial-cleanup-fixture/app/pull/9", user: { login: "dependabot[bot]" }, head: { sha: "sha9" } }
      ], { headers });
    }
    if (requestUrl.pathname === "/repos/partial-cleanup-fixture/app/commits/sha9/check-runs") {
      return Response.json({ check_runs: [{ status: "completed", conclusion: "failure" }] }, { headers });
    }
    if (requestUrl.pathname === "/repos/partial-cleanup-fixture/app/commits/sha9/status") {
      return Response.json({ statuses: [] }, { headers });
    }
    if (requestUrl.pathname === "/repos/partial-cleanup-fixture/app/actions/runs" && options.method === "GET") {
      const status = requestUrl.searchParams.get("status");
      if (status === "waiting") return Response.json({ message: "temporary failure" }, { status: 500, headers });
      const workflowRuns = status === "queued"
        ? [{ id: 90, name: "CI", status, actor: { login: "dependabot[bot]" } }]
        : [];
      return Response.json({ workflow_runs: workflowRuns }, { headers });
    }
    if (requestUrl.pathname === "/repos/partial-cleanup-fixture/app/pulls/9" && options.method === "PATCH") {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return Response.json({ state: "closed" }, { headers });
    }
    if (requestUrl.pathname === "/repos/partial-cleanup-fixture/app/actions/runs/90/cancel" && options.method === "POST") {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return new Response(null, { status: 202, headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  try {
    const result = await cleanupDependabotWorkload({ repos: ["partial-cleanup-fixture/app"], jobs: 2 });
    assert.equal(result.closedPullRequests.length, 1);
    assert.equal(result.cancelledRuns.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /waiting runs: temporary failure/);
    assert.deepEqual(mutations.sort(), [
      "PATCH /repos/partial-cleanup-fixture/app/pulls/9",
      "POST /repos/partial-cleanup-fixture/app/actions/runs/90/cancel"
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("cleanup stops before mutations when discovery exhausts GitHub quota", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const mutations = [];
  let getRequests = 0;

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (options.method === "GET") getRequests += 1;
    const remaining = requestUrl.pathname.endsWith("/actions/runs") ? "0" : "1000";
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": remaining,
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": "core"
    };
    if (/^\/repos\/quota-cleanup-fixture\/app-\d+\/pulls$/.test(requestUrl.pathname) && options.method === "GET") {
      return Response.json([
        { number: 10, title: "Bump dependency", user: { login: "dependabot[bot]" } }
      ], { headers });
    }
    if (/^\/repos\/quota-cleanup-fixture\/app-\d+\/actions\/runs$/.test(requestUrl.pathname) && options.method === "GET") {
      return Response.json({
        workflow_runs: [{ id: 100, status: requestUrl.searchParams.get("status"), actor: { login: "dependabot[bot]" } }]
      }, { headers });
    }
    if (["PATCH", "POST"].includes(options.method)) {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  resetObservedRateBuckets();
  try {
    const repos = Array.from({ length: 10 }, (_, index) => `quota-cleanup-fixture/app-${index + 1}`);
    const result = await cleanupDependabotWorkload({ repos, jobs: 2 });
    assert.deepEqual(result.closedPullRequests, []);
    assert.deepEqual(result.cancelledRuns, []);
    assert.equal(result.errors.some((error) => /quota/i.test(error)), true);
    assert.deepEqual(mutations, []);
    assert.ok(getRequests <= 6, `expected quota abort to bound discovery requests, received ${getRequests}`);
  } finally {
    resetObservedRateBuckets();
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("background queue scan paginates queued runs and observes its cooldown", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const mutations = [];
  let requestCount = 0;
  const now = Date.parse("2026-07-29T12:00:00Z");

  globalThis.fetch = async (url, options = {}) => {
    requestCount += 1;
    const requestUrl = new URL(String(url));
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4900",
      "x-ratelimit-reset": String(Math.floor(now / 1000) + 3600),
      "x-ratelimit-resource": "core"
    };
    if (requestUrl.pathname === "/user") return Response.json({ login: "queue-scheduler-user" }, { headers });
    if (requestUrl.pathname === "/user/orgs") return Response.json([{ login: "queue-scheduler-owner" }], { headers });
    if (requestUrl.pathname === "/orgs/queue-scheduler-owner/repos") {
      return Response.json([{ full_name: "queue-scheduler-owner/app", archived: false }], { headers });
    }
    if (requestUrl.pathname === "/repos/queue-scheduler-owner/app/pulls" && options.method === "GET") {
      return Response.json([
        { number: 11, title: "Bump dependency", html_url: "https://github.com/queue-scheduler-owner/app/pull/11", user: { login: "dependabot[bot]" }, head: { sha: "sha11" } }
      ], { headers });
    }
    if (requestUrl.pathname === "/repos/queue-scheduler-owner/app/commits/sha11/check-runs") {
      return Response.json({ check_runs: [{ status: "completed", conclusion: "failure" }] }, { headers });
    }
    if (requestUrl.pathname === "/repos/queue-scheduler-owner/app/commits/sha11/status") {
      return Response.json({ statuses: [] }, { headers });
    }
    if (requestUrl.pathname === "/repos/queue-scheduler-owner/app/actions/runs" && options.method === "GET") {
      const status = requestUrl.searchParams.get("status");
      const page = Number(requestUrl.searchParams.get("page") || 1);
      if (status === "queued" && page === 1) {
        return Response.json({
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            status: "queued",
            actor: { login: "maintainer" }
          }))
        }, { headers });
      }
      if (status === "queued" && page === 2) {
        return Response.json({
          workflow_runs: [{ id: 101, status: "queued", actor: { login: "dependabot[bot]" } }]
        }, { headers });
      }
      return Response.json({ workflow_runs: [] }, { headers });
    }
    if (requestUrl.pathname === "/repos/queue-scheduler-owner/app/actions/runs/101/cancel" && options.method === "POST") {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return new Response(null, { status: 202, headers });
    }
    if (requestUrl.pathname === "/repos/queue-scheduler-owner/app/pulls/11" && options.method === "PATCH") {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return Response.json({ state: "closed" }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  resetDependabotCleanupState();
  resetObservedRateBuckets();
  try {
    const result = await runDependabotQueueScan({
      threshold: 101,
      owners: ["queue-scheduler-owner"],
      jobs: 2,
      now
    });
    assert.equal(result.closedPullRequests.length, 1);
    assert.deepEqual(result.cancelledRuns.map((run) => run.runId), [101]);
    assert.deepEqual(mutations.sort(), [
      "PATCH /repos/queue-scheduler-owner/app/pulls/11",
      "POST /repos/queue-scheduler-owner/app/actions/runs/101/cancel"
    ]);

    const requestsAfterCleanup = requestCount;
    const cooldownResult = await runDependabotQueueScan({
      threshold: 101,
      owners: ["queue-scheduler-owner"],
      jobs: 2,
      now: now + 1000
    });
    assert.equal(cooldownResult, null);
    assert.equal(requestCount, requestsAfterCleanup);
  } finally {
    resetDependabotCleanupState();
    resetObservedRateBuckets();
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("a shallow queue still closes Dependabot PRs with failing CI without cancelling runs", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const mutations = [];
  const now = Date.parse("2026-07-31T14:10:00Z");

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4900",
      "x-ratelimit-reset": String(Math.floor(now / 1000) + 3600),
      "x-ratelimit-resource": "core"
    };
    if (requestUrl.pathname === "/user") return Response.json({ login: "shallow-queue-user" }, { headers });
    if (requestUrl.pathname === "/user/orgs") return Response.json([{ login: "shallow-queue-owner" }], { headers });
    if (requestUrl.pathname === "/orgs/shallow-queue-owner/repos") {
      return Response.json([{ full_name: "shallow-queue-owner/app", archived: false }], { headers });
    }
    if (requestUrl.pathname === "/repos/shallow-queue-owner/app/pulls" && options.method === "GET") {
      return Response.json([
        { number: 12, title: "Bump failing dep", user: { login: "dependabot[bot]" }, head: { sha: "fail-sha" } },
        { number: 13, title: "Bump green dep", user: { login: "dependabot[bot]" }, head: { sha: "pass-sha" } }
      ], { headers });
    }
    if (requestUrl.pathname === "/repos/shallow-queue-owner/app/commits/fail-sha/check-runs") {
      return Response.json({ check_runs: [{ status: "completed", conclusion: "failure" }] }, { headers });
    }
    if (requestUrl.pathname === "/repos/shallow-queue-owner/app/commits/pass-sha/check-runs") {
      return Response.json({ check_runs: [{ status: "completed", conclusion: "success" }] }, { headers });
    }
    if (/\/repos\/shallow-queue-owner\/app\/commits\/(fail|pass)-sha\/status$/.test(requestUrl.pathname)) {
      return Response.json({ statuses: [] }, { headers });
    }
    if (requestUrl.pathname === "/repos/shallow-queue-owner/app/actions/runs" && options.method === "GET") {
      // One lone queued Dependabot run — far below the threshold.
      const status = requestUrl.searchParams.get("status");
      const workflowRuns = status === "queued"
        ? [{ id: 200, name: "CI", status, actor: { login: "dependabot[bot]" } }]
        : [];
      return Response.json({ workflow_runs: workflowRuns }, { headers });
    }
    if (["PATCH", "POST"].includes(options.method)) {
      mutations.push(`${options.method} ${requestUrl.pathname}`);
      return Response.json({ state: "closed" }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  resetDependabotCleanupState();
  resetObservedRateBuckets();
  try {
    const result = await runDependabotQueueScan({
      threshold: 10,
      owners: ["shallow-queue-owner"],
      jobs: 2,
      now
    });
    assert.deepEqual(result.closedPullRequests.map((pr) => pr.number), [12]);
    assert.deepEqual(result.cancelledRuns, []);
    assert.deepEqual(mutations, ["PATCH /repos/shallow-queue-owner/app/pulls/12"]);
  } finally {
    resetDependabotCleanupState();
    resetObservedRateBuckets();
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("failing CI detection accepts REST lowercase check runs and legacy commit statuses", () => {
  assert.equal(hasFailedCiSignal([{ status: "completed", conclusion: "failure" }], []), true);
  assert.equal(hasFailedCiSignal([{ status: "completed", conclusion: "startup_failure" }], []), true);
  assert.equal(hasFailedCiSignal([{ status: "COMPLETED", conclusion: "FAILURE" }], []), true);
  assert.equal(hasFailedCiSignal([], [{ state: "failure" }]), true);
  assert.equal(hasFailedCiSignal([{ status: "completed", conclusion: "success" }], [{ state: "success" }]), false);
  assert.equal(hasFailedCiSignal([{ status: "completed", conclusion: "skipped" }], []), false);
  // An in-flight run that has not concluded must not read as a failure.
  assert.equal(hasFailedCiSignal([{ status: "in_progress", conclusion: null }], []), false);
  assert.equal(hasFailedCiSignal(undefined, undefined), false);
});

test("failed non-CD workflow runs stay in failing CI until a newer same-lane success resolves them", () => {
  const now = Date.parse("2026-05-23T19:25:00Z");
  const minutesAgo = (mins) => new Date(now - mins * 60 * 1000).toISOString();
  const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const runs = [
    {
      id: 7,
      name: "ci",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      head_branch: "feature",
      updated_at: minutesAgo(1)
    },
    {
      id: 6,
      name: "Deploy",
      path: ".github/workflows/deploy.yml",
      event: "push",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      updated_at: minutesAgo(2)
    },
    {
      id: 5,
      name: "ci",
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "success",
      head_branch: "release",
      updated_at: minutesAgo(3)
    },
    {
      id: 4,
      name: "ci",
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "failure",
      head_branch: "release",
      updated_at: minutesAgo(4)
    },
    {
      id: 3,
      name: "ci",
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      updated_at: minutesAgo(5)
    },
    {
      id: 2,
      name: "ci",
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      updated_at: daysAgo(8)
    }
  ];

  const failed = selectFailedActionRuns(runs, { now });
  assert.deepEqual(failed.map((run) => run.id), [3]);
});

test("only the latest completed run per lane surfaces as a failure", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  const minutesAgo = (mins) => new Date(now - mins * 60 * 1000).toISOString();
  const lane = { name: "ci", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", status: "completed" };
  // Two consecutive in-window failures in the same lane: only the newest shows.
  const sameLaneFailures = [
    { ...lane, id: 30, conclusion: "failure", updated_at: minutesAgo(5) },
    { ...lane, id: 29, conclusion: "failure", updated_at: minutesAgo(30) }
  ];
  assert.deepEqual(selectFailedActionRuns(sameLaneFailures, { now }).map((r) => r.id), [30]);

  // A newer success in the lane means the retry delivered: nothing surfaces.
  const retriedAndDelivered = [
    { ...lane, id: 31, conclusion: "success", updated_at: minutesAgo(2) },
    { ...lane, id: 30, conclusion: "failure", updated_at: minutesAgo(5) }
  ];
  assert.deepEqual(selectFailedActionRuns(retriedAndDelivered, { now }).map((r) => r.id), []);

  // Failures in different lanes are independent and both surface.
  const distinctLanes = [
    { ...lane, id: 40, conclusion: "failure", updated_at: minutesAgo(5) },
    { ...lane, id: 41, head_branch: "develop", conclusion: "failure", updated_at: minutesAgo(6) }
  ];
  assert.deepEqual(selectFailedActionRuns(distinctLanes, { now }).map((r) => r.id).sort(), [40, 41]);
});

test("workflow run conclusions are classified into actionable outcomes", () => {
  assert.equal(runOutcome({ conclusion: "success" }), "success");
  assert.equal(runOutcome({ conclusion: "neutral" }), "success");
  assert.equal(runOutcome({ conclusion: "skipped" }), "skipped");
  assert.equal(runOutcome({ conclusion: "SKIPPED" }), "skipped");
  assert.equal(runOutcome({ conclusion: "failure" }), "failure");
  assert.equal(runOutcome({ conclusion: "cancelled" }), "failure");
  assert.equal(runOutcome({ conclusion: "timed_out" }), "failure");
  assert.equal(runOutcome({ conclusion: "startup_failure" }), "failure");
  assert.equal(runOutcome({ conclusion: null }), "completed");
  assert.equal(runOutcome({}), "completed");
});

test("pipeline traces flag merged PRs that do not complete production CD", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  const traces = buildPipelineTraces({
    now,
    includeCd: true,
    pullRequests: [],
    mergedPullRequestsByRepo: new Map([
      ["acme/app", [
        {
          pr: {
            number: 12,
            title: "Ship billing export",
            html_url: "https://github.com/acme/app/pull/12",
            merged_at: "2026-06-01T11:30:00Z",
            head: { sha: "abc123" },
            merge_commit_sha: "def456",
            base: { ref: "main" },
            user: { login: "dev" }
          }
        }
      ]]
    ]),
    cdRowsByRepo: new Map([
      ["acme/app", [
        {
          repo: "acme/app",
          workflow: "Deploy Production",
          runNumber: "#44",
          status: "completed",
          conclusion: "failure",
          outcome: "failure",
          failureReason: "deploy failed",
          branch: "main",
          headSha: "def456",
          createdAt: "2026-06-01T11:35:00Z",
          updatedAt: "2026-06-01T11:40:00Z",
          url: "https://github.com/acme/app/actions/runs/44"
        }
      ]]
    ])
  });

  assert.equal(traces.flagged.length, 1);
  assert.equal(traces.flagged[0].id, "acme/app#12");
  assert.equal(traces.flagged[0].severity, "critical");
  assert.equal(traces.flagged[0].nextAction.label, "Open failed run");
  assert.match(traces.flagged[0].reason, /deploy failed/);
});

test("pipeline traces flag running workflows only after four hours", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  const openPr = {
    repo: "acme/app",
    number: 14,
    numberLabel: "#14",
    title: "Run long CI",
    url: "https://github.com/acme/app/pull/14",
    state: "running",
    createdAt: "2026-06-01T07:00:00Z",
    updatedAt: "2026-06-01T08:00:00Z"
  };
  const mergedPr = {
    pr: {
      number: 15,
      title: "Run long CD",
      html_url: "https://github.com/acme/app/pull/15",
      merged_at: "2026-06-01T07:00:00Z",
      merge_commit_sha: "def456",
      base: { ref: "main" },
      user: { login: "dev" }
    }
  };
  const runningCd = {
    repo: "acme/app",
    workflow: "Deploy Production",
    runNumber: "#46",
    status: "in_progress",
    branch: "main",
    headSha: "def456",
    createdAt: "2026-06-01T08:00:00Z",
    updatedAt: "2026-06-01T11:59:00Z",
    url: "https://github.com/acme/app/actions/runs/46"
  };

  const atFourHours = buildPipelineTraces({
    now,
    pullRequests: [openPr],
    mergedPullRequestsByRepo: new Map([["acme/app", [mergedPr]]]),
    cdRowsByRepo: new Map([["acme/app", [runningCd]]])
  });
  assert.equal(atFourHours.flagged.length, 0);
  assert.equal(atFourHours.active.length, 2);

  const overFourHours = buildPipelineTraces({
    now: now + 1,
    pullRequests: [openPr],
    mergedPullRequestsByRepo: new Map([["acme/app", [mergedPr]]]),
    cdRowsByRepo: new Map([["acme/app", [runningCd]]])
  });
  assert.equal(overFourHours.flagged.length, 2);
  assert.ok(overFourHours.flagged.every((trace) => /still running/i.test(trace.reason)));
});

test("pipeline traces mark successful production CD as completed", () => {
  const traces = buildPipelineTraces({
    now: Date.parse("2026-06-01T12:00:00Z"),
    includeCd: true,
    pullRequests: [],
    mergedPullRequestsByRepo: new Map([
      ["acme/app", [
        {
          pr: {
            number: 13,
            title: "Improve settings",
            html_url: "https://github.com/acme/app/pull/13",
            merged_at: "2026-06-01T11:30:00Z",
            head: { sha: "aaa111" },
            merge_commit_sha: "bbb222",
            base: { ref: "main" },
            user: { login: "dev" }
          }
        }
      ]]
    ]),
    cdRowsByRepo: new Map([
      ["acme/app", [
        {
          repo: "acme/app",
          workflow: "Deploy Production",
          runNumber: "#45",
          status: "completed",
          conclusion: "success",
          outcome: "success",
          branch: "main",
          headSha: "bbb222",
          createdAt: "2026-06-01T11:35:00Z",
          updatedAt: "2026-06-01T11:44:00Z",
          url: "https://github.com/acme/app/actions/runs/45"
        }
      ]]
    ])
  });

  assert.equal(traces.completed.length, 1);
  assert.equal(traces.completed[0].status, "completed");
  assert.equal(traces.flagged.length, 0);
  assert.equal(traces.completed[0].stages.at(-1).status, "complete");
});

test("pipeline traces keep unmapped repositories separate from failures", () => {
  const traces = buildPipelineTraces({
    now: Date.parse("2026-06-01T12:00:00Z"),
    includeCd: true,
    pullRequests: [],
    mergedPullRequestsByRepo: new Map([
      ["acme/docs", [
        {
          pr: {
            number: 2,
            title: "Docs polish",
            html_url: "https://github.com/acme/docs/pull/2",
            merged_at: "2026-06-01T10:00:00Z",
            base: { ref: "main" },
            user: { login: "writer" }
          }
        }
      ]]
    ]),
    cdRowsByRepo: new Map([["acme/docs", []]])
  });

  assert.equal(traces.unknown.length, 1);
  assert.equal(traces.flagged.length, 0);
  assert.match(traces.unknown[0].reason, /No production workflow/);
});

test("isDeployNeutralFile recognizes changelog/docs/repo-metadata", () => {
  assert.equal(isDeployNeutralFile("CHANGELOG.md"), true);
  assert.equal(isDeployNeutralFile("docs/CHANGELOG.md"), true);
  assert.equal(isDeployNeutralFile("CHANGELOG"), true);
  assert.equal(isDeployNeutralFile("HISTORY.md"), true);
  assert.equal(isDeployNeutralFile("README.md"), true);
  assert.equal(isDeployNeutralFile("LICENSE"), true);
  assert.equal(isDeployNeutralFile(".gitignore"), true);
  assert.equal(isDeployNeutralFile("src/app/page.jsx"), false);
  assert.equal(isDeployNeutralFile("server.js"), false);
  assert.equal(isDeployNeutralFile("styles/changelog.css"), false);
});

test("mergedPrIsDeployNeutral requires every file to be deploy-neutral", () => {
  assert.equal(mergedPrIsDeployNeutral([{ filename: "CHANGELOG.md" }]), true);
  assert.equal(mergedPrIsDeployNeutral([{ filename: "CHANGELOG.md" }, { filename: "README.md" }]), true);
  assert.equal(mergedPrIsDeployNeutral([{ filename: "CHANGELOG.md" }, { filename: "src/index.js" }]), false);
  // Unknown file list (not fetched) must not suppress a flag.
  assert.equal(mergedPrIsDeployNeutral([]), false);
});

test("pipeline traces do not flag a changelog-only merged PR with no matching CD run", () => {
  const traces = buildPipelineTraces({
    now: Date.parse("2026-06-01T12:00:00Z"),
    includeCd: true,
    pullRequests: [],
    mergedPullRequestsByRepo: new Map([
      ["ryabinski-labs/nightlamp", [
        {
          pr: {
            number: 447,
            title: "Update changelog",
            html_url: "https://github.com/ryabinski-labs/nightlamp/pull/447",
            merged_at: "2026-06-01T11:00:00Z",
            head: { sha: "feed01" },
            merge_commit_sha: "feed02",
            base: { ref: "main" },
            user: { login: "dev" }
          },
          files: [{ filename: "CHANGELOG.md", status: "modified" }]
        }
      ]]
    ]),
    // CD evidence exists for the repo, but none of it matches this PR.
    cdRowsByRepo: new Map([
      ["ryabinski-labs/nightlamp", [
        {
          repo: "ryabinski-labs/nightlamp",
          workflow: "Deploy Production",
          runNumber: "#900",
          status: "completed",
          conclusion: "success",
          outcome: "success",
          branch: "release/other",
          headSha: "0000ff",
          createdAt: "2026-05-30T10:00:00Z",
          updatedAt: "2026-05-30T10:05:00Z",
          url: "https://github.com/ryabinski-labs/nightlamp/actions/runs/900"
        }
      ]]
    ])
  });

  assert.equal(traces.flagged.length, 0);
  assert.equal(traces.completed.length, 1);
  assert.equal(traces.completed[0].id, "ryabinski-labs/nightlamp#447");
  assert.match(traces.completed[0].reason, /No production deploy expected/);
});

test("pipeline traces still flag a merged PR that mixes code with changelog", () => {
  const traces = buildPipelineTraces({
    now: Date.parse("2026-06-01T12:00:00Z"),
    includeCd: true,
    pullRequests: [],
    mergedPullRequestsByRepo: new Map([
      ["ryabinski-labs/nightlamp", [
        {
          pr: {
            number: 448,
            title: "Ship feature and update changelog",
            html_url: "https://github.com/ryabinski-labs/nightlamp/pull/448",
            merged_at: "2026-06-01T11:00:00Z",
            head: { sha: "abc999" },
            merge_commit_sha: "def999",
            base: { ref: "main" },
            user: { login: "dev" }
          },
          files: [{ filename: "CHANGELOG.md" }, { filename: "src/app/page.jsx" }]
        }
      ]]
    ]),
    cdRowsByRepo: new Map([
      ["ryabinski-labs/nightlamp", [
        {
          repo: "ryabinski-labs/nightlamp",
          workflow: "Deploy Production",
          runNumber: "#901",
          status: "completed",
          conclusion: "success",
          outcome: "success",
          branch: "release/other",
          headSha: "0000ff",
          createdAt: "2026-05-30T10:00:00Z",
          updatedAt: "2026-05-30T10:05:00Z",
          url: "https://github.com/ryabinski-labs/nightlamp/actions/runs/901"
        }
      ]]
    ])
  });

  assert.equal(traces.flagged.length, 1);
  assert.equal(traces.flagged[0].id, "ryabinski-labs/nightlamp#448");
  assert.match(traces.flagged[0].reason, /no matching production CD run/i);
});

test("dashboard scoreboard surfaces skipped CD runs without a new lane", () => {
  assert.match(indexHtml, /id="metricFinishedCdSub"/);
  assert.match(indexHtml, /id="navFinishedCdDot"/);
  assert.match(indexHtml, /class="metric metric-green"[\s\S]*?id="metricFinishedCdSub"/);
});

test("Failed CD nav dot has its own id so the rail can flag the still-failing state", () => {
  assert.match(indexHtml, /id="navFailedCdDot"/);
  // Subtitle was removed when the Failed CD list became "still failing only" — its dom node should not return.
  assert.equal(/id="metricFailedCdSub"/.test(indexHtml), false);
});

test("failed CD runs are surfaced even when a newer completed run displaces the latest entry", () => {
  // Regression: a CD workflow that fails, then has a follow-up run (success/skipped/etc.) was
  // dropping out of the Failed CD list because the categorization only looked at the latest
  // completed run per workflow. The failure still appears in Finished CD as FAILURE, so the
  // counts were inconsistent (Finished CD shows the FAILURE row but Failed CD shows 0).
  const now = Date.parse("2026-05-23T19:25:00Z");
  const minutesAgo = (mins) => new Date(now - mins * 60 * 1000).toISOString();
  const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const runs = [
    { id: 6, status: "in_progress", conclusion: null, updated_at: minutesAgo(1) },
    { id: 5, status: "completed", conclusion: "success", updated_at: minutesAgo(2) },
    { id: 4, status: "completed", conclusion: "skipped", updated_at: minutesAgo(15) },
    { id: 3, status: "completed", conclusion: "failure", updated_at: minutesAgo(30) },
    { id: 2, status: "completed", conclusion: "cancelled", updated_at: minutesAgo(120) },
    { id: 1, status: "completed", conclusion: "failure", updated_at: daysAgo(8) }
  ];

  const failed = selectFailedCdRuns(runs, { now });
  assert.deepEqual(failed.map((run) => run.id), [3, 2]);
});

test("findSupersedingSuccessfulRun marks a failure as resolved only when a newer success exists", () => {
  // completedRuns are newest-first (GitHub Actions API order).
  const succ414 = { id: 414, run_number: 414, conclusion: "success", html_url: "https://example/414" };
  const succ413 = { id: 413, run_number: 413, conclusion: "neutral", html_url: "https://example/413" };
  const skip413 = { id: 4131, run_number: 413, conclusion: "skipped", html_url: "https://example/413s" };
  const fail412 = { id: 412, run_number: 412, conclusion: "failure", html_url: "https://example/412" };
  const fail411 = { id: 411, run_number: 411, conclusion: "failure", html_url: "https://example/411" };

  // Newer success → resolved.
  assert.equal(
    findSupersedingSuccessfulRun([succ414, fail412, fail411], fail412),
    succ414
  );
  // Neutral counts as success (matches runOutcome).
  assert.equal(
    findSupersedingSuccessfulRun([succ413, fail412], fail412),
    succ413
  );
  // Newer skipped does NOT resolve a failure (production was not deployed).
  assert.equal(findSupersedingSuccessfulRun([skip413, fail412], fail412), null);
  // Newer failure does not resolve.
  assert.equal(findSupersedingSuccessfulRun([fail411, fail412], fail412), null);
  // Newest position → nothing newer → null.
  assert.equal(findSupersedingSuccessfulRun([fail412, fail411], fail412), null);
  // Failed run not present → null (no spurious match).
  assert.equal(findSupersedingSuccessfulRun([succ414, fail411], fail412), null);
  // Returns the first newer success even when an intervening run also failed.
  assert.equal(
    findSupersedingSuccessfulRun([succ414, fail411, fail412], fail412),
    succ414
  );
});

test("selectFailedCdRuns ignores non-completed runs and unknown timestamps", () => {
  const now = Date.parse("2026-05-23T19:25:00Z");
  const runs = [
    { id: 1, status: "queued", conclusion: null, updated_at: new Date(now).toISOString() },
    { id: 2, status: "completed", conclusion: "failure", updated_at: "not-a-date" },
    { id: 3, status: "completed", conclusion: "success", updated_at: new Date(now).toISOString() },
    { id: 4, status: "completed", conclusion: "failure", created_at: new Date(now - 1000).toISOString() }
  ];

  const failed = selectFailedCdRuns(runs, { now });
  assert.deepEqual(failed.map((run) => run.id), [4]);
});

test("conditional cache attaches If-None-Match only for GET/HEAD with a known ETag", () => {
  const store = new Map();
  const base = { accept: "application/vnd.github+json" };
  // No cached entry → headers unchanged.
  assert.deepEqual(applyConditionalHeaders(base, store, "https://api/x", "GET"), base);

  // Mutation methods never read the cache, even when an ETag is known.
  store.set("https://api/x", { etag: 'W/"abc"', body: { ok: true } });
  assert.equal("if-none-match" in applyConditionalHeaders(base, store, "https://api/x", "POST"), false);
  assert.equal("if-none-match" in applyConditionalHeaders(base, store, "https://api/x", "PATCH"), false);
  assert.equal("if-none-match" in applyConditionalHeaders(base, store, "https://api/x", "DELETE"), false);

  // GET with a cached ETag attaches the header without mutating the base headers.
  const next = applyConditionalHeaders(base, store, "https://api/x", "GET");
  assert.equal(next["if-none-match"], 'W/"abc"');
  assert.equal(next.accept, "application/vnd.github+json");
  assert.equal("if-none-match" in base, false);
});

test("304 returns the cached body and any other status returns null", () => {
  const store = new Map();
  store.set("https://api/x", { etag: 'W/"abc"', body: { value: 7 } });
  assert.deepEqual(takeCachedConditionalResponse(store, "https://api/x", "GET", 304), { value: 7 });
  // Different URL or method → no cached body.
  assert.equal(takeCachedConditionalResponse(store, "https://api/y", "GET", 304), null);
  assert.equal(takeCachedConditionalResponse(store, "https://api/x", "POST", 304), null);
  // Non-304 statuses don't read the cache.
  assert.equal(takeCachedConditionalResponse(store, "https://api/x", "GET", 200), null);
  assert.equal(takeCachedConditionalResponse(store, "https://api/x", "GET", 404), null);
});

test("storeConditionalResponse caches GET bodies with their ETag and evicts entries that no longer carry one", () => {
  const store = new Map();
  const responseWithEtag = { headers: { get: (h) => (h.toLowerCase() === "etag" ? 'W/"v1"' : null) } };
  const responseWithoutEtag = { headers: { get: () => null } };

  assert.equal(storeConditionalResponse(store, "https://api/x", "GET", responseWithEtag, { value: 1 }), true);
  assert.deepEqual(store.get("https://api/x"), { etag: 'W/"v1"', body: { value: 1 } });

  // A later response that carries no ETag should evict the stale cached entry rather than serve it forever.
  assert.equal(storeConditionalResponse(store, "https://api/x", "GET", responseWithoutEtag, { value: 2 }), false);
  assert.equal(store.has("https://api/x"), false);

  // Mutations never write the cache.
  assert.equal(storeConditionalResponse(store, "https://api/x", "POST", responseWithEtag, { value: 3 }), false);
  assert.equal(store.has("https://api/x"), false);
});

test("isBackendUrl accurately identifies backend and API subdomains", () => {
  assert.equal(isBackendUrl("https://api.vectraseo.com"), true);
  assert.equal(isBackendUrl("https://backend.example.com/billing"), true);
  assert.equal(isBackendUrl("https://api-prod.someapp.io"), true);
  assert.equal(isBackendUrl("https://mybackend-prod.com"), false);
  assert.equal(isBackendUrl("https://app.vectraseo.com/billing"), false);
  assert.equal(isBackendUrl("https://vectraseo.com"), false);
  assert.equal(isBackendUrl(""), false);
  assert.equal(isBackendUrl(null), false);
});

test("extractOwnerFromPath returns the owner for /repos, /orgs, /users paths and null elsewhere", () => {
  assert.equal(extractOwnerFromPath("/repos/GipsyChef/agentdraft/pulls"), "GipsyChef");
  assert.equal(extractOwnerFromPath("/repos/GipsyChef/agentdraft/git/refs/heads/main"), "GipsyChef");
  assert.equal(extractOwnerFromPath("/orgs/GipsyChef/actions/runners"), "GipsyChef");
  assert.equal(extractOwnerFromPath("/users/octocat/events"), "octocat");
  // Owner-less paths.
  assert.equal(extractOwnerFromPath("/search/issues"), null);
  assert.equal(extractOwnerFromPath("/user"), null);
  assert.equal(extractOwnerFromPath("/installation/repositories"), null);
  assert.equal(extractOwnerFromPath("/graphql"), null);
  assert.equal(extractOwnerFromPath(""), null);
  assert.equal(extractOwnerFromPath(null), null);
  // Full URLs to api.github.com are honored; other hosts are not.
  assert.equal(extractOwnerFromPath("https://api.github.com/repos/GipsyChef/nightlamp/pulls/1"), "GipsyChef");
  assert.equal(extractOwnerFromPath("https://api.github.com/graphql"), null);
  assert.equal(extractOwnerFromPath("https://example.com/repos/foo/bar"), null);
});

test("buildAppJwtPayload uses the documented claim shape and 9-minute exp", () => {
  const payload = buildAppJwtPayload("123456", 1_700_000_000);
  assert.equal(payload.iss, "123456");
  assert.equal(payload.iat, 1_700_000_000 - 60);
  assert.equal(payload.exp, 1_700_000_000 + 540);
  // App ID always stringified — GitHub accepts string or number, we normalize.
  assert.equal(typeof buildAppJwtPayload(99, 0).iss, "string");
});

test("signAppJwt produces a verifiable RS256 JWT", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = signAppJwt({ appId: "42", privateKey: privateKeyPem, nowSeconds: 1_700_000_000 });
  const [encodedHeader, encodedPayload, signature] = jwt.split(".");
  // Three parts, all base64url, no padding.
  assert.equal(jwt.split(".").length, 3);
  assert.ok(!encodedHeader.includes("="));
  assert.ok(!signature.includes("="));
  // Header claims the RS256 algorithm.
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  // Payload survives a round-trip and matches buildAppJwtPayload.
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.deepEqual(payload, buildAppJwtPayload("42", 1_700_000_000));
  // Signature verifies against the public key.
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  assert.equal(verifier.verify(publicKey, signature, "base64url"), true);
});

test("installationTokenIsValid requires a 90-second safety margin before expiry", () => {
  const now = 1_700_000_000;
  assert.equal(installationTokenIsValid(null, now), false);
  assert.equal(installationTokenIsValid(undefined, now), false);
  // Fresh token: 1 hour out.
  assert.equal(installationTokenIsValid({ token: "x", expiresAt: now + 3600 }, now), true);
  // Just past the 90s safety margin: still valid (91s of headroom).
  assert.equal(installationTokenIsValid({ token: "x", expiresAt: now + 91 }, now), true);
  // Right at the margin: not valid (refresh proactively).
  assert.equal(installationTokenIsValid({ token: "x", expiresAt: now + 90 }, now), false);
  // Already expired.
  assert.equal(installationTokenIsValid({ token: "x", expiresAt: now - 1 }, now), false);
});

function fakeResponse({ limit, remaining, reset, resource = "core", used }) {
  const headers = new Map([
    ["x-ratelimit-limit", String(limit)],
    ["x-ratelimit-remaining", String(remaining)],
    ["x-ratelimit-reset", String(reset)],
    ["x-ratelimit-resource", resource]
  ]);
  if (used !== undefined) headers.set("x-ratelimit-used", String(used));
  return { headers: { get: (key) => headers.get(key) ?? null } };
}

test("recordRateLimit accumulates one bucket per (resource, installation) across scans", async () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  // Simulate two separate scans that each only hit a subset of installations.
  await scanMetrics.run(createScanMetrics(), async () => {
    recordRateLimit(fakeResponse({ limit: 5000, remaining: 4999, reset }), { installationKey: "cigan1" });
    recordRateLimit(fakeResponse({ limit: 6450, remaining: 5475, reset }), { installationKey: "gipsychef" });
  });
  await scanMetrics.run(createScanMetrics(), async () => {
    recordRateLimit(fakeResponse({ limit: 5000, remaining: 4998, reset }), { installationKey: "siftfy" });
  });
  // Second scan saw only siftfy, but the snapshot still includes cigan1 and gipsychef.
  const snap = snapshotRateLimit(scanMetrics.getStore() || createScanMetrics());
  assert.equal(snap.bucketCount, 3);
  const keys = snap.buckets.map((b) => b.installationKey).sort();
  assert.deepEqual(keys, ["cigan1", "gipsychef", "siftfy"]);
});

test("snapshotRateLimit picks tightest by ratio across installations", () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  // GipsyChef has a higher limit but is more depleted by ratio.
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 4999, reset, used: 1 }), { installationKey: "cigan1" });
  recordRateLimit(fakeResponse({ limit: 6450, remaining: 1000, reset, used: 5450 }), { installationKey: "gipsychef" });
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 4500, reset, used: 500 }), { installationKey: "siftfy" });
  const snap = snapshotRateLimit(createScanMetrics());
  assert.equal(snap.bucketCount, 3);
  assert.equal(snap.tightest.installationKey, "gipsychef");
  assert.equal(snap.buckets[0].installationKey, "gipsychef");
  assert.equal(snap.buckets.length, 3);
  // resources collapses to one-per-resource (the tightest installation per resource).
  assert.equal(snap.resources.length, 1);
  assert.equal(snap.resources[0].installationKey, "gipsychef");
});

test("snapshotRateLimit single-bucket case mirrors PAT mode", () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 3068, reset, used: 1932 }), { installationKey: "pat" });
  const snap = snapshotRateLimit(createScanMetrics());
  assert.equal(snap.bucketCount, 1);
  assert.equal(snap.tightest.installationKey, "pat");
  assert.equal(snap.tightest.remaining, 3068);
});

test("snapshotRateLimit picks tightest across mixed resources and installations", () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 6450, remaining: 5000, reset, used: 1450 }), { installationKey: "gipsychef" });
  // search bucket is much smaller and more depleted by ratio.
  recordRateLimit(fakeResponse({ resource: "search", limit: 30, remaining: 2, reset, used: 28 }), { installationKey: "gipsychef" });
  const snap = snapshotRateLimit(createScanMetrics());
  assert.equal(snap.tightest.resource, "search");
  assert.equal(snap.tightest.remaining, 2);
  assert.equal(snap.bucketCount, 2);
});

test("recordRateLimit ratchets remaining downward within the same reset window", () => {
  resetObservedRateBuckets();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 4500, reset }), { installationKey: "cigan1" });
  // A stale response with a higher `remaining` arrives — must not overwrite the lower value.
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 4700, reset }), { installationKey: "cigan1" });
  const snap = snapshotRateLimit(createScanMetrics());
  assert.equal(snap.buckets[0].remaining, 4500);

  // After the reset window changes, accept the fresh higher quota.
  const newerReset = reset + 3600;
  recordRateLimit(fakeResponse({ limit: 5000, remaining: 5000, reset: newerReset }), { installationKey: "cigan1" });
  const snap2 = snapshotRateLimit(createScanMetrics());
  assert.equal(snap2.buckets[0].remaining, 5000);
});
