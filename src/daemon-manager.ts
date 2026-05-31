// Daemon lifecycle: ensure a single background daemon is running, survive the
// parent (MCP) process exit, and expose stop/status. This is what makes
// kiro-recall "install once, runs when Kiro runs": the MCP server calls
// ensureDaemonRunning() on boot.
//
// Singleton strategy (timing invariant): a health probe against the fixed port
// is the source of truth ("is a daemon already serving?"). The PID file is a
// best-effort handle for stop/status. Two MCP processes racing both probe;
// whichever spawns first wins, the other's probe then succeeds.

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DATA_DIR, HOST, PORT } from "./config.ts";

const PID_FILE = join(DATA_DIR, "daemon.pid");
const HEALTH_URL = `http://${HOST}:${PORT}/api/health`;

function daemonEntry(): string {
  // <this file>/../daemon.ts
  return join(dirname(fileURLToPath(import.meta.url)), "daemon.ts");
}

export async function isDaemonHealthy(timeoutMs = 1200): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// Spawn the daemon fully detached so it outlives this (MCP) process.
function spawnDetached(): number | null {
  mkdirSync(DATA_DIR, { recursive: true });
  const bun = process.execPath; // the bun binary running us
  const child = spawn(bun, ["run", daemonEntry()], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KIRO_RECALL_SPAWNED_BY: "mcp" },
  });
  child.unref();
  if (child.pid) {
    try {
      writeFileSync(PID_FILE, String(child.pid));
    } catch {
      // non-fatal
    }
  }
  return child.pid ?? null;
}

// Called by the MCP server on boot. Non-blocking-friendly: returns quickly,
// never throws. If a daemon is already healthy, does nothing.
export async function ensureDaemonRunning(): Promise<
  "already-running" | "spawned" | "failed"
> {
  if (await isDaemonHealthy()) {
    return "already-running";
  }
  const pid = spawnDetached();
  if (!pid) {
    return "failed";
  }
  // Give it a moment to bind the port, then confirm.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isDaemonHealthy()) {
      return "spawned";
    }
  }
  return "failed";
}

export async function statusReport(): Promise<string> {
  const healthy = await isDaemonHealthy();
  const pid = readPid();
  const pidState = pid ? (pidAlive(pid) ? `pid ${pid} alive` : `pid ${pid} dead`) : "no pidfile";
  return healthy
    ? `daemon: healthy at ${HEALTH_URL} (${pidState})`
    : `daemon: not running (${pidState})`;
}

export function stopDaemon(): string {
  const pid = readPid();
  if (!pid) {
    return "no pidfile; nothing to stop";
  }
  if (!pidAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    return `pid ${pid} already dead; cleared pidfile`;
  }
  try {
    process.kill(pid, "SIGTERM");
    rmSync(PID_FILE, { force: true });
    return `sent SIGTERM to pid ${pid}`;
  } catch (e) {
    return `failed to stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
