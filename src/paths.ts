// Locates Kiro's globalStorage (the read-only source of truth) across platforms.
// We never write here. Coupling is limited to this directory layout + the JSON
// schema parsed in ingest/parser.ts.

import { homedir, platform } from "os";
import { existsSync, readdirSync, type Dirent } from "fs";
import { join } from "path";
import { AGENT_DIR_OVERRIDE } from "./config.ts";

const AGENT_DIR = "kiro.kiroagent";

// Candidate roots for Kiro user data, by platform.
function kiroUserDirs(): string[] {
  const home = homedir();
  const p = platform();
  if (p === "darwin") {
    return [join(home, "Library", "Application Support", "Kiro", "User")];
  }
  if (p === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return [join(appData, "Kiro", "User")];
  }
  // linux + others
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [join(xdg, "Kiro", "User")];
}

// Allow explicit override for tests / non-standard installs.
export function kiroAgentDir(): string | null {
  // Override via KIRO_RECALL_AGENT_DIR env or paths.agent_dir in config.toml.
  if (AGENT_DIR_OVERRIDE && existsSync(AGENT_DIR_OVERRIDE)) {
    return AGENT_DIR_OVERRIDE;
  }
  for (const userDir of kiroUserDirs()) {
    const candidate = join(userDir, "globalStorage", AGENT_DIR);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// The per-project session store: <agentDir>/workspace-sessions/<base64url(path)>/
export function workspaceSessionsDir(): string | null {
  const agent = kiroAgentDir();
  if (!agent) {
    return null;
  }
  const dir = join(agent, "workspace-sessions");
  return existsSync(dir) ? dir : null;
}

// Kiro encodes the workspace absolute path as base64url (padding stripped) for
// the directory name. Decode defensively — return null on garbage.
export function decodeWorkspaceDirName(name: string): string | null {
  try {
    const b64 = name.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    // Sanity: decoded workspace paths are absolute.
    if (decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded)) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

// Locate Kiro's per-execution agent logs (the current-era "exec store"). Each
// file is one agent execution as JSON:
//   { executionId, chatSessionId, workflowType, input, actions[], result, ... }
// The REAL assistant output lives in actions[]: actionType "say" (prose) and
// "reasoning" (thinking). The workspace-session transcript only keeps the
// "On it." stub on the assistant turn, but carries that turn's `executionId`,
// which equals this file's top-level `executionId` — so we can splice the real
// text back onto the right turn.
//
// Layout (observed): <agentDir>/<workspaceHash>/<chatHash>/<file> — two nested
// hash levels, leaf files have no extension. We walk that shape only (depth 2),
// skipping workspace-sessions (handled elsewhere). Returns absolute paths.
export function execLogFiles(): string[] {
  const agent = kiroAgentDir();
  if (!agent) {
    return [];
  }
  const out: string[] = [];
  let level1: Dirent[];
  try {
    level1 = readdirSync(agent, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const l1 of level1) {
    if (!l1.isDirectory() || l1.name === "workspace-sessions") {
      continue;
    }
    const l1Path = join(agent, l1.name);
    let level2: Dirent[];
    try {
      level2 = readdirSync(l1Path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const l2 of level2) {
      if (!l2.isDirectory()) {
        continue;
      }
      const l2Path = join(l1Path, l2.name);
      let leaves: Dirent[];
      try {
        leaves = readdirSync(l2Path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const leaf of leaves) {
        if (leaf.isFile()) {
          out.push(join(l2Path, leaf.name));
        }
      }
    }
  }
  return out;
}
