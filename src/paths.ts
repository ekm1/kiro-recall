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


// Locate Kiro's per-execution chat logs (the *.chat files). These hold the
// REAL agent output — reasoning + tool calls — that the workspace-session
// transcripts only stub as "On it." (the assistant turn's content is literally
// that short acknowledgement; the substance lives here, reachable via the
// executionId on the transcript turn).
//
// danilop/kiro-total-recall reads these *.chat files directly as its IDE
// source; we ingest them as an additional source alongside the transcripts.
// Recursive (bounded) scan under the agent dir, so we don't hard-code the
// exact sub-directory layout.
export function chatFiles(maxDepth = 5, cap = 50000): string[] {
  const agent = kiroAgentDir();
  if (!agent) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= cap) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        // workspace-sessions only holds .json transcripts (handled elsewhere);
        // skipping it avoids descending that large tree for nothing.
        if (e.name === "workspace-sessions") {
          continue;
        }
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".chat")) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(agent, 0);
  return out;
}
