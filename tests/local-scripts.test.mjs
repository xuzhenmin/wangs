import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wangs-script-test-"));
  const binaryDirectory = path.join(directory, ".runtime/node/bin");
  const log = path.join(directory, "commands.jsonl");
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(path.join(directory, "scripts"));
  await mkdir(path.join(directory, "node_modules/.bin"), { recursive: true });
  for (const filename of ["install-low-memory.sh", "start-local.sh"]) {
    await copyFile(new URL(`../scripts/${filename}`, import.meta.url), path.join(directory, "scripts", filename));
  }
  await symlink(process.execPath, path.join(binaryDirectory, "node"));
  for (const name of ["npm", "uname", "lsof", "next"]) {
    const target = name === "next"
      ? path.join(directory, "node_modules/.bin/next")
      : path.join(binaryDirectory, name);
    await copyFile(new URL("./fixtures/local-script-command.cjs", import.meta.url), target);
    await chmod(target, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    NODE_OPTIONS: "--no-warnings",
    NPM_HEAP_MB: "384",
    LOCAL_BUILD_HEAP_MB: "",
    LOCAL_SITE_HOST: "127.0.0.1",
    LOCAL_SITE_PORT: String(await availablePort()),
    WANGS_TEST_INSTALL_EXIT: "0",
    WANGS_TEST_COMMAND_LOG: log,
  };
  async function events() {
    const content = await readFile(log, "utf8").catch(() => "");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  t.after(async () => {
    for (const event of await events()) {
      if (event.command === "next") {
        try { process.kill(event.pid, "SIGTERM"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  function run(script, args = [], overrides = {}) {
    return spawnSync("bash", [path.join(directory, "scripts", script), ...args], {
      env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000,
    });
  }
  async function existingBuild() {
    await mkdir(path.join(directory, ".next"));
    await writeFile(path.join(directory, ".next/BUILD_ID"), "fixture-build");
    await writeFile(path.join(directory, ".next/required-server-files.json"), "{}");
  }
  return { run, events, existingBuild };
}

test("installer limits npm memory/concurrency while retaining build and platform dependencies", async (t) => {
  const f = await fixture(t);
  const result = f.run("install-low-memory.sh");
  assert.equal(result.status, 0, result.stderr);
  const [install] = (await f.events()).filter((event) => event.args[0] === "ci");
  assert.equal(install.nodeOptions, "--no-warnings --max-old-space-size=384");
  assert.equal(install.threads, "1");
  assert.equal(install.jobs, "1");
  assert.equal(install.makeflags, "-j1");
  for (const flag of ["--include=dev", "--include=optional", "--foreground-scripts", "--maxsockets=1"]) {
    assert.ok(install.args.includes(flag));
  }
});

test("check mode and malformed heap settings never start npm ci", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("install-low-memory.sh", ["--check"]).status, 0);
  assert.equal(f.run("install-low-memory.sh", [], { NPM_HEAP_MB: "96" }).status, 2);
  assert.equal(f.run("start-local.sh", [], { LOCAL_BUILD_HEAP_MB: "no" }).status, 2);
  assert.equal((await f.events()).length, 0);
});

test("failed installation preserves exit status and reports SIGKILL separately", async (t) => {
  const f = await fixture(t);
  const killed = f.run("install-low-memory.sh", [], { WANGS_TEST_INSTALL_EXIT: "137" });
  assert.equal(killed.status, 137);
  assert.match(killed.stderr, /SIGKILL/);
  assert.doesNotMatch(killed.stdout, /安装完成/);
  const failed = f.run("install-low-memory.sh", [], { WANGS_TEST_INSTALL_EXIT: "42" });
  assert.equal(failed.status, 42);
});

test("skip-build refuses an absent production build", async (t) => {
  const f = await fixture(t);
  const result = f.run("start-local.sh", ["--skip-build"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /没有可用的生产构建/);
  assert.equal((await f.events()).filter((event) => event.command === "next" || event.args[0] === "run").length, 0);
});

test("skip-build starts an existing build without running npm build", async (t) => {
  const f = await fixture(t);
  await f.existingBuild();
  const result = f.run("start-local.sh", ["--skip-build"]);
  assert.equal(result.status, 0, result.stderr);
  const events = await f.events();
  assert.equal(events.filter((event) => event.command === "next").length, 1);
  assert.equal(events.filter((event) => event.args[0] === "run").length, 0);
});

test("build heap limit is applied to the build only, not the launched server", async (t) => {
  const f = await fixture(t);
  const result = f.run("start-local.sh", [], { LOCAL_BUILD_HEAP_MB: "512" });
  assert.equal(result.status, 0, result.stderr);
  const events = await f.events();
  const build = events.find((event) => event.command === "npm" && event.args[0] === "run");
  const runtime = events.find((event) => event.command === "next");
  assert.equal(build.nodeOptions, "--no-warnings --max-old-space-size=512");
  assert.equal(runtime.nodeOptions, "--no-warnings");
});
