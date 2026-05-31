// Idle shutdown: the daemon should not outlive the IDE. We can't get a "Kiro
// closed" event, so we poll for a running Kiro process. When Kiro has been
// absent for IDLE_SHUTDOWN_MS, the daemon exits cleanly.
//
// This is best-effort and conservative: if we cannot determine process state,
// we assume Kiro is present (never shut down on uncertainty).

import { spawnSync } from "child_process";
import { IDLE_SHUTDOWN_MS, IDLE_CHECK_INTERVAL_MS } from "../config.ts";
import { log } from "../log.ts";

// Heuristic: is a Kiro IDE process alive? Matches the app/agent process names
// seen on macOS/Linux. On Windows we check via tasklist.
function isKiroRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const res = spawnSync("tasklist", [], { encoding: "utf-8" });
      return /kiro/i.test(res.stdout || "");
    }
    // macOS/Linux: pgrep matches Kiro.app / kiro / kiroAgent.
    const res = spawnSync("pgrep", ["-if", "kiro"], { encoding: "utf-8" });
    // pgrep exit 0 = found. Guard against matching ourselves (bun process
    // running kiro-recall) by requiring a line that isn't just our own pid.
    if (res.status !== 0) {
      return false;
    }
    const pids = (res.stdout || "")
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n !== process.pid);
    return pids.length > 0;
  } catch {
    return true; // uncertain -> assume present, never shut down by mistake
  }
}

let lastSeen = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

export function startIdleMonitor(onShutdown: () => void): void {
  if (IDLE_SHUTDOWN_MS <= 0) {
    log.info("IDLE", "idle shutdown disabled");
    return;
  }
  lastSeen = Date.now();
  timer = setInterval(() => {
    if (isKiroRunning()) {
      lastSeen = Date.now();
      return;
    }
    const idle = Date.now() - lastSeen;
    if (idle >= IDLE_SHUTDOWN_MS) {
      log.info("IDLE", "Kiro not running; shutting down daemon", { idleMs: idle });
      onShutdown();
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

export function stopIdleMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
