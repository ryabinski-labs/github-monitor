import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, copyFile, utimes, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.ryabinski.github-monitor";

// The service commands drive launchd, which CI (Linux) does not have and a
// developer's Mac must not have touched by a test. launchctl, curl, lsof, ps
// and id are stubs sharing one state directory, so "loaded", "pid" and "healthy"
// are whatever a test says; everything else start.sh calls is the real tool.
// touch and rm are for the stubs, not start.sh.
const HOST_TOOLS = ["dirname", "sed", "head", "cat", "mkdir", "tail", "awk", "grep", "date", "touch", "rm"];
const BASH = ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"].find((candidate) => existsSync(candidate));

const HEALTHY = JSON.stringify({
  ok: true,
  authMode: "app",
  quota: { status: "ok", blocked: false, resource: "core", installationKey: "acme", remaining: 4000, limit: 5000 }
});

async function linkHostTool(bin, name) {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    if (existsSync(`${dir}/${name}`)) {
      await symlink(`${dir}/${name}`, path.join(bin, name));
      return;
    }
  }
  throw new Error(`start.sh needs ${name}, which is not on this machine`);
}

async function stage({ loaded = false, installedPlist = null } = {}) {
  // Resolved because start.sh records the physical checkout path, and macOS's
  // tmpdir sits behind the /var -> /private/var symlink.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "start-sh-svc-")));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const checkout = path.join(dir, "checkout");
  for (const d of [home, bin, state, path.join(checkout, "macos")]) await mkdir(d, { recursive: true });
  await copyFile(path.join(root, "start.sh"), path.join(checkout, "start.sh"));
  await chmod(path.join(checkout, "start.sh"), 0o755);
  await copyFile(path.join(root, "macos", `${LABEL}.plist`), path.join(checkout, "macos", `${LABEL}.plist`));
  await writeFile(path.join(checkout, "server.js"), "");
  // Keeps the preflight's credential check on its no-gh path.
  await writeFile(path.join(checkout, ".env"), "GITHUB_TOKEN=stub-token\n");
  if (loaded) {
    await writeFile(path.join(state, "loaded"), "");
    await writeFile(path.join(state, "pid"), "100\n");
  }
  if (installedPlist !== null) {
    await mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`), installedPlist);
  }

  const stub = async (name, body) => {
    await writeFile(path.join(bin, name), `#!${BASH}\nS="${state}"\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
  await stub(
    "launchctl",
    [
      'echo "$*" >> "$S/calls"',
      'case "$1" in',
      '  print)     [ -f "$S/loaded" ] || exit 113',
      '             printf "%s = {\\n\\tstate = running\\n\\truns = 1\\n\\tpid = %s\\n}\\n" "$2" "$(cat "$S/pid")" ;;',
      // A fresh process per load, as launchd gives: 100 for the first.
      '  bootstrap) touch "$S/loaded"; echo $(( $(cat "$S/pid" 2>/dev/null || echo 99) + 1 )) > "$S/pid" ;;',
      '  bootout)   rm -f "$S/loaded" ;;',
      '  kickstart) echo $(( $(cat "$S/pid") + 1 )) > "$S/pid" ;;',
      "esac"
    ].join("\n")
  );
  await stub(
    "lsof",
    [
      'if [ -f "$S/foreign" ]; then cat "$S/foreign"; exit 0; fi',
      '[ -f "$S/loaded" ] || exit 1',
      'cat "$S/pid"'
    ].join("\n")
  );
  await stub(
    "curl",
    [
      '[ -f "$S/loaded" ] || [ -f "$S/foreign" ] || exit 7',
      'if [ -f "$S/health" ]; then cat "$S/health"; else printf "%s" \'' + HEALTHY + "'; fi"
    ].join("\n")
  );
  // A server that started this second: anything written before now is not newer.
  await stub("ps", 'echo "00:00"');
  await stub("id", "echo 501");
  await stub("sleep", "exit 0");
  await symlink(process.execPath, path.join(bin, "node"));
  for (const name of HOST_TOOLS) await linkHostTool(bin, name);

  const run = (...args) =>
    new Promise((resolve) => {
      execFile(
        BASH,
        [path.join(checkout, "start.sh"), ...args],
        { cwd: dir, timeout: 30000, env: { HOME: home, PATH: bin, PORT: "45177", START_SH_WAIT_SECONDS: "3" } },
        (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
      );
    });
  const calls = async () => (existsSync(path.join(state, "calls")) ? readFile(path.join(state, "calls"), "utf8") : "");
  return { run, calls, dir, home, bin, state, checkout };
}

test("start installs the LaunchAgent for this checkout and waits for it to answer", async () => {
  const { run, calls, home, bin, checkout } = await stage();
  const result = await run("start");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /LaunchAgent installed/);
  assert.match(result.stdout, /Serving http:\/\/localhost:45177 \(pid 100\)/);

  const installed = await readFile(path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`), "utf8");
  assert.match(installed, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${checkout}</string>`));
  assert.match(installed, new RegExp(`<string>${bin}/node</string>`), "runs the node that is actually installed");
  assert.match(installed, new RegExp(`--env-file-if-exists=${checkout}/\\.env`));
  assert.match(installed, new RegExp(`<string>${home}/Library/Logs/github-monitor\\.log</string>`));
  assert.match(await calls(), /^bootstrap gui\/501 .*com\.ryabinski\.github-monitor\.plist$/m);
});

test("start leaves a running agent alone instead of restarting it", async () => {
  const first = await stage();
  await first.run("start");
  const result = await first.run("start");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Already running \(pid 100\)/);
  assert.doesNotMatch(await first.calls(), /kickstart/);
});

test("start refuses to take over an agent installed for another checkout", async () => {
  const plist = `<plist><dict>\n<key>WorkingDirectory</key>\n<string>/somewhere/else</string>\n</dict></plist>\n`;
  const { run, calls } = await stage({ installedPlist: plist });
  const result = await run("start");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /runs another checkout: \/somewhere\/else/);
  assert.doesNotMatch(await calls(), /bootstrap|bootout|kickstart/);
});

test("start will not fight a foreground server for the port", async () => {
  const { run, calls, state } = await stage();
  await writeFile(path.join(state, "foreign"), "999\n");
  const result = await run("start");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /held by pid 999, which launchd did not start/);
  assert.doesNotMatch(await calls(), /bootstrap/);
});

test("restart replaces the running process and waits for the new pid", async () => {
  const first = await stage();
  await first.run("start");
  const result = await first.run("restart");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(await first.calls(), /^kickstart -k gui\/501\/com\.ryabinski\.github-monitor$/m);
  assert.match(result.stdout, /Serving .* \(pid 101\)/);
});

test("restart reloads the job when the checked-in plist has changed", async () => {
  // launchd reads a plist only at bootstrap, so a kickstart would keep running
  // the old definition.
  const first = await stage();
  await first.run("start");
  const plist = path.join(first.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  await writeFile(plist, (await readFile(plist, "utf8")).replace("<integer>60</integer>", "<integer>30</integer>"));
  const result = await first.run("restart");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /LaunchAgent updated/);
  const calls = (await first.calls()).trim().split("\n");
  const bootout = calls.findIndex((call) => call.startsWith("bootout"));
  assert.ok(bootout >= 0 && calls.slice(bootout).some((call) => call.startsWith("bootstrap")), calls.join("\n"));
  assert.doesNotMatch(calls.join("\n"), /kickstart/);
  assert.match(await readFile(plist, "utf8"), /<integer>60<\/integer>/);
});

test("stop unloads the agent", async () => {
  const { run, calls } = await stage({ loaded: true });
  const result = await run("stop");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(await calls(), /^bootout gui\/501\/com\.ryabinski\.github-monitor$/m);
  assert.match(result.stdout, /Stopped/);
});

test("status is 0 and reads auth and quota from /api/health when healthy", async () => {
  const { run } = await stage({ loaded: true });
  const result = await run("status");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /running · pid 100/);
  assert.match(result.stdout, /ok · GitHub App · quota ok 4000\/5000 \(acme core\)/);
  assert.match(result.stdout, /running what is on disk/);
});

test("status is 1 when nothing is loaded or answering", async () => {
  const { run } = await stage();
  const result = await run("status");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /not loaded/);
  assert.match(result.stdout, /nothing answers on 127\.0\.0\.1:45177/);
});

test("status is 2 when the code on disk is newer than the running server", async () => {
  const { run, checkout } = await stage({ loaded: true });
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(checkout, "server.js"), later, later);
  const result = await run("status");
  assert.equal(result.code, 2);
  assert.match(result.stdout, /changed after the server started — \.\/start\.sh restart/);
});

test("status is 2 when GitHub quota has paused requests", async () => {
  const { run, state } = await stage({ loaded: true });
  await writeFile(
    path.join(state, "health"),
    JSON.stringify({ ok: true, authMode: "pat", quota: { status: "exhausted", blocked: true, resource: "core", remaining: 0, limit: 5000 } })
  );
  const result = await run("status");
  assert.equal(result.code, 2);
  assert.match(result.stdout, /! ok · token auth · quota exhausted 0\/5000 · requests paused until reset/);
});

test("an unknown command prints usage and exits 64", async () => {
  const { run } = await stage();
  const result = await run("launch");
  assert.equal(result.code, 64);
  assert.match(result.stderr, /\.\/start\.sh status/);
});
