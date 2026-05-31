#!/usr/bin/env bun
// kiro-recall unified CLI. Single entry, claude-mem style subcommands.
//
//   kiro-recall install        register MCP + steering in ~/.kiro (install once)
//   kiro-recall uninstall      remove MCP + steering (keeps DB)
//   kiro-recall start          ensure background daemon is running (detached)
//   kiro-recall stop           stop the daemon
//   kiro-recall status         daemon health + pid
//   kiro-recall scan           one-shot scan, then exit
//   kiro-recall rebuild        wipe derived DB + full re-scan
//   kiro-recall ui             ensure daemon, print/open the UI url
//   kiro-recall search <q>     keyword search from the terminal
//   kiro-recall mcp            run the MCP server (Kiro spawns this)
//   kiro-recall daemon         run the daemon in the foreground
//
// Path-independent: all module paths resolve relative to THIS file, so the
// command works from any cwd and when installed globally.

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function runBun(entry: string, args: string[] = []): number {
  const res = spawnSync(process.execPath, ["run", join(SRC, entry), ...args], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  return res.status ?? 1;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "install":
      process.exit(runBun("install.ts", ["install", ...rest]));
      break;
    case "uninstall":
      process.exit(runBun("install.ts", ["uninstall", ...rest]));
      break;
    case "start":
      process.exit(runBun("cli.ts", ["start"]));
      break;
    case "stop":
      process.exit(runBun("cli.ts", ["stop"]));
      break;
    case "status":
      process.exit(runBun("cli.ts", ["status"]));
      break;
    case "scan":
      process.exit(runBun("daemon.ts", ["--scan-once"]));
      break;
    case "rebuild":
      process.exit(runBun("daemon.ts", ["--rebuild"]));
      break;
    case "daemon":
      process.exit(runBun("daemon.ts"));
      break;
    case "mcp":
      process.exit(runBun("mcp/server.ts"));
      break;
    case "ui": {
      const { ensureDaemonRunning } = await import(join(SRC, "daemon-manager.ts"));
      const { HOST, PORT } = await import(join(SRC, "config.ts"));
      const r = await ensureDaemonRunning();
      const url = `http://${HOST}:${PORT}`;
      console.log(`daemon: ${r}`);
      console.log(`UI: ${url}`);
      if (process.platform === "darwin") {
        spawnSync("open", [url], { stdio: "ignore" });
      }
      process.exit(0);
      break;
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) {
        console.error("usage: kiro-recall search <query>");
        process.exit(2);
      }
      const { searchMessages } = await import(join(SRC, "search/fts.ts"));
      const hits = searchMessages(query, { limit: 20 });
      if (hits.length === 0) {
        console.log(`No results for "${query}".`);
      } else {
        for (const h of hits) {
          console.log(`[${h.projectName}] "${h.title}" — ${h.role}: ${h.snippet}`);
        }
      }
      process.exit(0);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      const pkg = await import(join(ROOT, "package.json"), { with: { type: "json" } });
      console.log((pkg as any).default?.version ?? "unknown");
      process.exit(0);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      process.exit(0);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`kiro-recall — persistent, browsable conversation memory for Kiro IDE

Usage: kiro-recall <command>

  install      register MCP server + steering in ~/.kiro (run once)
  uninstall    remove MCP + steering (keeps your memory DB)
  start        ensure the background daemon is running
  stop         stop the daemon
  status       daemon health + pid
  scan         one-shot scan of Kiro sessions, then exit
  rebuild      wipe derived DB and re-scan everything
  ui           ensure daemon + open the web UI
  search <q>   keyword search from the terminal
  mcp          run the MCP server (Kiro spawns this automatically)
  daemon       run the daemon in the foreground
  version      print version
`);
}

main();
