// Repo attribution (method 2): a Kiro session in a multi-root workspace is
// stamped only with the workspace's PRIMARY root. To recover which repo(s) a
// chat was actually about, we scan the transcript for absolute file paths and
// match them against the set of known repo roots.
//
// Root registry sources (union):
//   1. Folder lists inside every *.code-workspace referenced by Kiro's
//      workspaceStorage (the real multi-root membership).
//   2. Every distinct workspaceDirectory Kiro recorded (base64url dir names
//      under workspace-sessions) — each is a valid root on its own.
//
// Matching is longest-prefix, so nested roots (FE vs FE/rethink-monoverse)
// resolve to the most specific repo.

import { readdirSync, readFileSync, existsSync } from "fs";
import { homedir, platform } from "os";
import { dirname, join, resolve } from "path";
import { decodeWorkspaceDirName, workspaceSessionsDir } from "../paths.ts";
import { log } from "../log.ts";

function kiroUserDir(): string | null {
  const home = homedir();
  const p = platform();
  const candidates =
    p === "darwin"
      ? [join(home, "Library", "Application Support", "Kiro", "User")]
      : p === "win32"
        ? [join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Kiro", "User")]
        : [join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Kiro", "User")];
  return candidates.find(existsSync) ?? null;
}

// Read folder paths out of every *.code-workspace Kiro knows about.
function rootsFromCodeWorkspaces(): string[] {
  const userDir = kiroUserDir();
  if (!userDir) {
    return [];
  }
  const wsStorage = join(userDir, "workspaceStorage");
  if (!existsSync(wsStorage)) {
    return [];
  }
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(wsStorage);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const wsJson = join(wsStorage, entry, "workspace.json");
    if (!existsSync(wsJson)) {
      continue;
    }
    let codeWsPath: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(wsJson, "utf-8"));
      if (typeof parsed.workspace === "string" && parsed.workspace.startsWith("file://")) {
        codeWsPath = decodeURIComponent(parsed.workspace.slice("file://".length));
      }
    } catch {
      continue;
    }
    if (!codeWsPath || !existsSync(codeWsPath)) {
      continue;
    }
    try {
      const ws = JSON.parse(readFileSync(codeWsPath, "utf-8"));
      const folders = Array.isArray(ws.folders) ? ws.folders : [];
      const base = dirname(codeWsPath);
      for (const f of folders) {
        if (f && typeof f.path === "string") {
          out.push(resolve(base, f.path));
        }
      }
    } catch {
      // ignore malformed code-workspace
    }
  }
  return out;
}

// Each base64url dir name under workspace-sessions decodes to a workspaceDirectory.
function rootsFromSessionDirs(): string[] {
  const root = workspaceSessionsDir();
  if (!root) {
    return [];
  }
  const out: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      const decoded = decodeWorkspaceDirName(name);
      if (decoded) {
        out.push(decoded);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

export interface RepoRegistry {
  // Roots sorted longest-first for greedy longest-prefix matching.
  roots: string[];
}

let cached: RepoRegistry | null = null;

export function loadRepoRegistry(force = false): RepoRegistry {
  if (cached && !force) {
    return cached;
  }
  const set = new Set<string>();
  for (const r of rootsFromCodeWorkspaces()) {
    set.add(normalize(r));
  }
  for (const r of rootsFromSessionDirs()) {
    set.add(normalize(r));
  }
  const roots = [...set].sort((a, b) => b.length - a.length);
  cached = { roots };
  log.info("REPOS", "registry loaded", { count: roots.length });
  return cached;
}

function normalize(p: string): string {
  // Strip trailing slash, collapse nothing else (paths are already absolute).
  return p.replace(/\/+$/, "");
}

// Absolute POSIX paths inside transcript text. Greedy on path chars; trailing
// punctuation is trimmed by the matcher.
const ABS_PATH_RE = /\/[A-Za-z0-9._\-/]+/g;

// Longest-prefix match: a candidate path belongs to a root if it equals the
// root or sits beneath it (root + "/").
function rootForPath(candidate: string, roots: string[]): string | null {
  for (const root of roots) {
    if (candidate === root || candidate.startsWith(root + "/")) {
      return root;
    }
  }
  return null;
}

export interface RepoAttribution {
  // repo path -> number of references found in the transcript
  counts: Map<string, number>;
}

// Tally which repos a transcript touches, by scanning all message text.
export function attributeRepos(
  texts: string[],
  registry: RepoRegistry,
): RepoAttribution {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const matches = text.match(ABS_PATH_RE);
    if (!matches) {
      continue;
    }
    for (const raw of matches) {
      const cleaned = raw.replace(/[).,:;'"]+$/, "");
      const root = rootForPath(cleaned, registry.roots);
      if (root) {
        counts.set(root, (counts.get(root) ?? 0) + 1);
      }
    }
  }
  return { counts };
}
