#!/usr/bin/env node
// Node-runnable entry point. This is what `npx kiro-recall ...` invokes.
//
// The rest of kiro-recall runs on Bun (bun:sqlite, Bun.serve), but npx runs
// under Node — so this bootstrap must be plain CommonJS with NO bun APIs and
// NO bun shebang. Its job:
//   1. find bun; if missing, install it (curl bun.sh) — the "install bun for me"
//      behavior users expect.
//   2. exec `bun run <root>/bin/kiro-recall.ts <args>` for every command.

"use strict";

const { spawnSync, execSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");
const os = require("os");

const ROOT = join(__dirname, "..");
const REAL_CLI = join(__dirname, "kiro-recall.ts");

const BUN_CANDIDATES = [
  join(os.homedir(), ".bun", "bin", "bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
];

function onPathBun() {
  const r = spawnSync("bun", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return r.status === 0 ? "bun" : null;
}

function findBun() {
  return onPathBun() || BUN_CANDIDATES.find(existsSync) || null;
}

function installBun() {
  process.stderr.write("kiro-recall: bun not found — installing…\n");
  if (process.platform === "win32") {
    execSync('powershell -c "irm bun.sh/install.ps1 | iex"', { stdio: "inherit" });
  } else {
    execSync("curl -fsSL https://bun.sh/install | bash", { stdio: "inherit", shell: "/bin/bash" });
  }
}

function main() {
  let bun = findBun();
  if (!bun) {
    try {
      installBun();
    } catch (e) {
      process.stderr.write(
        "kiro-recall: failed to install bun automatically.\n" +
          "Install it manually from https://bun.sh and re-run.\n",
      );
      process.exit(1);
    }
    bun = findBun();
    if (!bun) {
      process.stderr.write(
        "kiro-recall: bun installed but not found on PATH yet.\n" +
          "Restart your terminal (or `source ~/.bashrc`) and re-run.\n",
      );
      process.exit(1);
    }
  }

  const args = process.argv.slice(2);
  const res = spawnSync(bun, ["run", REAL_CLI, ...args], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  process.exit(res.status == null ? 1 : res.status);
}

main();
