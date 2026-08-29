import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chmod, symlink, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// start.sh is run out of a scratch copy rather than the repo: it sources the
// repo's own .env, so testing it in place would let a developer's real
// GITHUB_APP_ID decide whether these assertions pass.
// PATH is built from scratch rather than inheriting the system one: GitHub's
// runners ship gh in /usr/bin, so `withGh: false` only meant "no gh" on a
// machine that happens to keep it somewhere else. Everything start.sh invokes
// is either stubbed here or symlinked in by name.
const HOST_TOOLS = ["dirname", "sleep"];

// With PATH replaced, bash cannot be found by name -- not for the script itself
// and not for the stubs' shebang lines.
const BASH = ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"].find((candidate) => existsSync(candidate));

async function linkHostTool(bin, name) {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    if (existsSync(`${dir}/${name}`)) {
      await symlink(`${dir}/${name}`, path.join(bin, name));
      return;
    }
  }
  throw new Error(`start.sh needs ${name}, which is not on this machine`);
}

async function stage({ env = {}, withGh = true, ghStatusExit = 0, ghToken = "stub-token", dotenv = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "start-sh-"));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await copyFile(path.join(root, "start.sh"), path.join(dir, "start.sh"));
  await chmod(path.join(dir, "start.sh"), 0o755);
  // Stands in for the server: start.sh execs it, so its exit code becomes the
  // script's and its marker proves the script got all the way past the checks.
  await writeFile(path.join(dir, "server.js"), 'console.log("STUB_SERVER_STARTED");\n');
  if (dotenv !== null) await writeFile(path.join(dir, ".env"), dotenv);

  const stub = async (name, body) => {
    await writeFile(path.join(bin, name), `#!${BASH}\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
  // The real port check would fail whenever a dashboard is already running.
  await stub("lsof", "exit 1");
  // Lets the browser-opening subshell finish on its first pass instead of
  // sleeping through ten retries.
  await stub("curl", "exit 0");
  await stub("open", "exit 0");
  if (withGh) {
    await stub(
      "gh",
      [
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit "${STUB_GH_STATUS_EXIT:-0}"; fi',
        'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then',
        '  [ -n "${STUB_GH_TOKEN:-}" ] || exit 1',
        '  printf "%s\\n" "$STUB_GH_TOKEN"; exit 0',
        "fi",
        "exit 1"
      ].join("\n")
    );
  }
  // node has to stay reachable by name (start.sh runs `node -p` and `node
  // server.js`) while gh must not be, and on this machine they share a
  // directory -- hence a symlink rather than keeping that directory on PATH.
  await symlink(process.execPath, path.join(bin, "node"));
  for (const name of HOST_TOOLS) await linkHostTool(bin, name);

  return new Promise((resolve) => {
    execFile(
      BASH,
      [path.join(dir, "start.sh")],
      {
        cwd: dir,
        timeout: 30000,
        env: {
          HOME: process.env.HOME,
          PATH: bin,
          STUB_GH_STATUS_EXIT: String(ghStatusExit),
          STUB_GH_TOKEN: ghToken,
          PORT: "45177",
          ...env
        }
      },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, dir })
    );
  });
}

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----\n";

async function keyFile(name = "key.pem") {
  const dir = await mkdtemp(path.join(tmpdir(), "start-sh-key-"));
  const file = path.join(dir, name);
  await writeFile(file, KEY);
  await chmod(file, 0o600);
  return file;
}

test("App auth starts the server without gh installed at all", async () => {
  const result = await stage({
    withGh: false,
    env: { GITHUB_APP_ID: "3829432", GITHUB_APP_PRIVATE_KEY_PATH: await keyFile() }
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /GitHub App auth \(id 3829432\)/);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
  assert.doesNotMatch(result.stdout, /gh is not authenticated/);
});

test("App auth ignores a gh login that reports failure", async () => {
  // The exact combination that blocked startup: a valid App key, and a gh
  // whose auth status exits non-zero because its PAT is rate limited.
  const result = await stage({
    ghStatusExit: 1,
    ghToken: "",
    env: { GITHUB_APP_ID: "3829432", GITHUB_APP_PRIVATE_KEY_PATH: await keyFile() }
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
});

test("App auth configured from .env is picked up before the credential check", async () => {
  const key = await keyFile();
  const result = await stage({
    withGh: false,
    dotenv: `GITHUB_APP_ID=3829432\nGITHUB_APP_PRIVATE_KEY_PATH=${key}\n`
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /GitHub App auth \(id 3829432\)/);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
});

test("an unreadable App private key fails fast and names the path", async () => {
  const missing = path.join(tmpdir(), "start-sh-absent", "nope.pem");
  const result = await stage({
    env: { GITHUB_APP_ID: "3829432", GITHUB_APP_PRIVATE_KEY_PATH: missing }
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /private key is not readable at .*nope\.pem/);
  assert.doesNotMatch(result.stdout, /STUB_SERVER_STARTED/);
});

test("a ~-relative App key path is expanded the same way server.js expands it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "start-sh-home-"));
  await writeFile(path.join(home, "key.pem"), KEY);
  const result = await stage({
    withGh: false,
    env: { HOME: home, GITHUB_APP_ID: "3829432", GITHUB_APP_PRIVATE_KEY_PATH: "~/key.pem" }
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
});

test("half-configured App auth warns and falls back to gh instead of starting on it", async () => {
  const result = await stage({ env: { GITHUB_APP_ID: "3829432" } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /half-configured/);
  assert.match(result.stdout, /gh authenticated/);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
});

test("a rate-limited gh auth status still starts when a token is stored", async () => {
  const result = await stage({ ghStatusExit: 1, ghToken: "stub-token" });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /rate-limiting the check/);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
});

test("gh with no stored token at all is still a hard stop", async () => {
  const result = await stage({ ghStatusExit: 1, ghToken: "" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /gh is not authenticated/);
  assert.doesNotMatch(result.stdout, /STUB_SERVER_STARTED/);
});

test("GITHUB_TOKEN is accepted without gh, matching how server.js resolves a PAT", async () => {
  const result = await stage({ withGh: false, env: { GITHUB_TOKEN: "stub-token" } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /token from GITHUB_TOKEN\/GH_TOKEN/);
  assert.match(result.stdout, /STUB_SERVER_STARTED/);
});

test("no credential of any kind, and no gh, reports the missing CLI", async () => {
  const result = await stage({ withGh: false });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /gh CLI not found/);
  assert.doesNotMatch(result.stdout, /STUB_SERVER_STARTED/);
});
