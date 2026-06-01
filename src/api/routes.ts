// REST handlers. Pure functions returning JSON-serializable data.

import {
  listProjects,
  listSessions,
  getMessages,
  getSession,
  counts,
  listRepos,
  listSessionsByRepo,
  listUntaggedSessions,
  countUntaggedSessions,
  getSessionRepos,
} from "../store/sessions.ts";
import { searchMessages } from "../search/fts.ts";
import { getMeta } from "../store/db.ts";
import { listObservations } from "../store/observations.ts";

export function apiHealth() {
  return {
    ok: true,
    counts: counts(),
    lastScan: Number(getMeta("last_scan")) || null,
    time: Date.now(),
  };
}

export function apiProjects() {
  return { projects: listProjects() };
}

// Method 2 grouping: repos a chat actually touched.
export function apiRepos() {
  return { repos: listRepos(), untagged: countUntaggedSessions() };
}

// Sessions with no repo attribution (the "Untagged" bucket in the UI).
export function apiUntaggedSessions() {
  return { sessions: listUntaggedSessions() };
}

export function apiSessions(projectId?: number) {
  return { sessions: listSessions(projectId) };
}

// Sessions filtered by repo (the primary grouping the UI uses).
export function apiSessionsByRepo(repo: string) {
  return { sessions: listSessionsByRepo(repo) };
}

export function apiSession(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) {
    return null;
  }
  return {
    session,
    repos: getSessionRepos(sessionId),
    messages: getMessages(sessionId),
    observations: listObservations(sessionId),
  };
}

export function apiSearch(query: string, opts: { repo?: string; projectId?: number } = {}) {
  const { hits, total } = searchMessages(query, opts);
  return { query, hits, total };
}
