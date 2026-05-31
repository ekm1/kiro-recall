// HTTP server: REST API under /api/* and static webview UI for everything else.

import { join } from "path";
import { fileURLToPath } from "url";
import { HOST, PORT } from "../config.ts";
import { log } from "../log.ts";
import {
  apiHealth,
  apiProjects,
  apiRepos,
  apiSessions,
  apiSessionsByRepo,
  apiSession,
  apiSearch,
} from "./routes.ts";

const UI_DIR = join(dirnameOf(import.meta.url), "..", "ui");

function dirnameOf(metaUrl: string): string {
  return join(fileURLToPath(metaUrl), "..");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(UI_DIR, rel);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }
  // SPA fallback
  const index = Bun.file(join(UI_DIR, "index.html"));
  if (await index.exists()) {
    return new Response(index);
  }
  return new Response("Not found", { status: 404 });
}

export function startServer(): void {
  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (path === "/api/health") {
          return json(apiHealth());
        }
        if (path === "/api/projects") {
          return json(apiProjects());
        }
        if (path === "/api/repos") {
          return json(apiRepos());
        }
        if (path === "/api/sessions-by-repo") {
          const repo = url.searchParams.get("repo");
          if (!repo) {
            return json({ error: "missing repo" }, 400);
          }
          return json(apiSessionsByRepo(repo));
        }
        if (path === "/api/sessions") {
          const pid = url.searchParams.get("projectId");
          return json(apiSessions(pid ? Number(pid) : undefined));
        }
        if (path === "/api/session") {
          const id = url.searchParams.get("id");
          if (!id) {
            return json({ error: "missing id" }, 400);
          }
          const data = apiSession(id);
          return data ? json(data) : json({ error: "not found" }, 404);
        }
        if (path === "/api/search") {
          const q = url.searchParams.get("q") || "";
          const repo = url.searchParams.get("repo");
          const pid = url.searchParams.get("projectId");
          return json(apiSearch(q, { repo: repo || undefined, projectId: pid ? Number(pid) : undefined }));
        }
        if (path.startsWith("/api/")) {
          return json({ error: "unknown endpoint" }, 404);
        }
        return await serveStatic(path);
      } catch (e) {
        log.error("API", "request failed", {
          path,
          error: e instanceof Error ? e.message : String(e),
        });
        return json({ error: "internal" }, 500);
      }
    },
  });

  log.info("API", "listening", { url: `http://${server.hostname}:${server.port}` });
}
