// Installer: makes kiro-recall "install once, runs when Kiro runs".
//
//   bun run bin/kiro-recall.ts install            -> global (~/.kiro), every session
//   bun run bin/kiro-recall.ts install --local     -> current workspace (./.kiro)
//   bun run bin/kiro-recall.ts install --local DIR  -> a specific workspace dir
//
// Idempotent + non-destructive: merges the MCP entry (never clobbers other
// servers) and writes a steering file. Uninstall removes only what we added.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const SERVER_KEY = "kiro-recall";

function repoRoot(): string {
  // <root>/src/install.ts -> <root>
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

// Resolve the .kiro base dir: global home, or a workspace dir for --local.
function kiroBase(local: string | null): string {
  if (local) {
    return join(resolve(local), ".kiro");
  }
  return join(homedir(), ".kiro");
}

function bunPath(): string {
  return process.execPath; // the bun running this installer
}

function globalKiroMemBin(): string | null {
  const res = spawnSync("which", ["kiro-recall"], { encoding: "utf-8" });
  const path = res.status === 0 ? res.stdout.trim() : "";
  return path && existsSync(path) ? path : null;
}

function mcpEntry() {
  const globalBin = globalKiroMemBin();
  const base = globalBin
    ? { command: globalBin, args: ["mcp"] }
    : { command: bunPath(), args: ["run", join(repoRoot(), "bin", "kiro-recall.ts"), "mcp"] };
  return {
    type: "stdio",
    ...base,
    description:
      "kiro-recall: recall past Kiro conversations per repo. Auto-starts the memory daemon + UI.",
    autoApprove: ["kiro_recall_search", "kiro_recall_recall", "kiro_recall_get_session"],
  };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function registerMcp(base: string): string {
  const cfg = join(base, "settings", "mcp.json");
  mkdirSync(dirname(cfg), { recursive: true });
  const config = readJson(cfg) ?? {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  config.mcpServers[SERVER_KEY] = mcpEntry();
  writeFileSync(cfg, JSON.stringify(config, null, 2) + "\n");
  return `registered MCP server "${SERVER_KEY}" in ${cfg}`;
}

function unregisterMcp(base: string): string {
  const cfg = join(base, "settings", "mcp.json");
  const config = readJson(cfg);
  if (!config?.mcpServers?.[SERVER_KEY]) {
    return "MCP entry not present";
  }
  delete config.mcpServers[SERVER_KEY];
  writeFileSync(cfg, JSON.stringify(config, null, 2) + "\n");
  return `removed MCP server "${SERVER_KEY}"`;
}

const STEERING_CONTENT = `---
inclusion: always
---

# kiro-recall — conversation memory recall

You have a persistent memory of past Kiro conversations, grouped by the repo
each chat actually touched, exposed via the \`kiro-recall\` MCP server.

## When to recall
Before non-trivial work on a repo you have not discussed this session, call
\`kiro_recall_search\` with a short, specific query (e.g. the feature, bug, or file
you are about to touch). If a result looks relevant, fetch the full transcript
with \`kiro_recall_get_session\`.

Use \`kiro_recall_recall\` (optionally scoped to a repo name) at the start of work to
see recent related sessions.

## Quiet by default
Do not narrate memory lookups unless asked. If a search returns nothing useful,
just continue.

## Browse
A web UI of all conversation history (per repo) is served by the kiro-recall daemon
at http://127.0.0.1:37800 when Kiro is running.
`;

function writeSteering(base: string): string {
  const dir = join(base, "steering");
  const file = join(dir, "kiro-recall.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, STEERING_CONTENT);
  return `wrote steering ${file}`;
}

function removeSteering(base: string): string {
  const file = join(base, "steering", "kiro-recall.md");
  if (existsSync(file)) {
    rmSync(file, { force: true });
    return `removed steering ${file}`;
  }
  return "steering not present";
}

// Parse `--local [dir]` from args.
function parseLocal(args: string[]): string | null {
  const i = args.indexOf("--local");
  if (i === -1) {
    return null;
  }
  const next = args[i + 1];
  // If a path follows (and isn't another flag), use it; else current dir.
  return next && !next.startsWith("--") ? next : process.cwd();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] || "install";
  const local = parseLocal(args);
  const base = kiroBase(local);
  const scope = local ? `local (${base})` : "global (~/.kiro)";
  const lines: string[] = [];

  if (cmd === "install") {
    lines.push(`scope: ${scope}`);
    lines.push(registerMcp(base));
    lines.push(writeSteering(base));
    lines.push("");
    lines.push("Next: reload Kiro (Developer: Reload Window).");
    lines.push("The kiro-recall daemon auto-starts; UI at http://127.0.0.1:37800");
  } else if (cmd === "uninstall") {
    lines.push(`scope: ${scope}`);
    lines.push(unregisterMcp(base));
    lines.push(removeSteering(base));
    lines.push("Note: leaves your memory DB intact (~/.kiro-recall).");
  } else {
    lines.push(`unknown command "${cmd}". Use: install [--local [dir]] | uninstall [--local [dir]]`);
  }

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

main();
