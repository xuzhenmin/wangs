#!/usr/bin/env node
// Controlled subprocesses used only by local-scripts.test.mjs.
/* eslint-disable @typescript-eslint/no-require-imports -- Copied as extensionless commands into a CommonJS test fixture. */
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");
/* eslint-enable @typescript-eslint/no-require-imports */

const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (command === "uname") {
  // Avoid both host launchd and host /proc in the isolated test workspace.
  console.log("FixtureOS");
  process.exit(0);
}
if (command === "lsof") process.exit(1);
if (command === "npm" && args[0] === "--version") {
  console.log("10.9.4");
  process.exit(0);
}
appendFileSync(process.env.WANGS_TEST_COMMAND_LOG, `${JSON.stringify({
  command, args, pid: process.pid,
  nodeOptions: process.env.NODE_OPTIONS || "",
  threads: process.env.UV_THREADPOOL_SIZE,
  jobs: process.env.npm_config_jobs,
  makeflags: process.env.MAKEFLAGS,
})}\n`);

if (command === "npm") {
  if (args[0] === "ci") process.exit(Number(process.env.WANGS_TEST_INSTALL_EXIT || 0));
  if (args[0] === "run" && args[1] === "build") {
    mkdirSync(".next", { recursive: true });
    writeFileSync(".next/BUILD_ID", "fixture-build");
    writeFileSync(".next/required-server-files.json", "{}");
  }
  process.exit(0);
}
if (command === "next") {
  const port = Number(args[args.indexOf("--port") + 1]);
  const hostname = args[args.indexOf("--hostname") + 1];
  createServer((_request, response) => response.end("fixture ready")).listen(port, hostname);
}
