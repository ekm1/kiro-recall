// kiro-recall webview. Vanilla JS, no build step. Talks to the daemon REST API.

const state = {
  repos: [],
  activeRepo: null,
  activeRepoName: "",
  activeSessionId: null,
  searchTerm: "",
  mode: "repo", // "repo" | "search"
};

const $ = (sel) => document.querySelector(sel);

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}`);
  }
  return res.json();
}

// ---------- helpers ----------

function fmtRelative(ms) {
  if (!ms) {
    return "";
  }
  const diff = Date.now() - Number(ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  return new Date(Number(ms)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

function fmtFull(ms) {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Deterministic color per repo name (hashed hue).
function repoColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 60%)`;
}

// Render message text: fenced code blocks -> <pre>, inline `code` -> <code>.
function renderBody(text, term) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]*\n/, "");
        return `<pre><code>${escapeHtml(inner)}</code></pre>`;
      }
      let safe = escapeHtml(part).replace(/`([^`\n]+)`/g, "<code>$1</code>");
      if (term) safe = applyHighlight(safe, term);
      return safe;
    })
    .join("");
}

function applyHighlight(safeHtml, term) {
  const tokens = term.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return safeHtml;
  const re = new RegExp(`(${tokens.join("|")})`, "gi");
  // avoid matching inside tags
  return safeHtml.replace(/(>[^<]+|^[^<]+)/g, (chunk) => chunk.replace(re, "<mark>$1</mark>"));
}

// ---------- health ----------

async function loadHealth() {
  const status = $("#status");
  try {
    const h = await api("/api/health");
    const c = h.counts;
    status.className = "status ok";
    status.textContent = `${c.projects} repos · ${c.sessions} chats · ${c.messages.toLocaleString()} msgs`;
  } catch {
    status.className = "status off";
    status.textContent = "daemon offline";
  }
}

// ---------- repos ----------

async function loadRepos() {
  const { repos } = await api("/api/repos");
  state.repos = repos;
  renderRepos();
}

function renderRepos() {
  const pane = $("#repos");
  pane.innerHTML = "";
  const label = el("div", "section-label");
  label.appendChild(el("span", null, "Repos"));
  label.appendChild(el("span", "count", String(state.repos.length)));
  pane.appendChild(label);

  for (const r of state.repos) {
    const row = el("div", "row repo-row");
    const ico = el("div", "repo-ico", r.name.slice(0, 1).toUpperCase());
    ico.style.background = repoColor(r.name);
    row.appendChild(ico);
    row.appendChild(el("span", "repo-name", r.name));
    row.appendChild(el("span", "repo-count", String(r.session_count)));
    row.title = r.repo;
    row.onclick = () => selectRepo(r.repo, r.name);
    if (r.repo === state.activeRepo) row.classList.add("active");
    pane.appendChild(row);
  }
}

async function selectRepo(repo, name) {
  state.mode = "repo";
  state.activeRepo = repo;
  state.activeRepoName = name || repo.split("/").pop();
  renderRepos();
  const scopeLabel = $("#scope-label");
  scopeLabel.hidden = false;
  $("#scope-name").textContent = state.activeRepoName;
  const { sessions } = await api(`/api/sessions-by-repo?repo=${encodeURIComponent(repo)}`);
  renderSessions(sessions, `${state.activeRepoName}`);
}

// ---------- sessions ----------

function renderSessions(sessions, labelText) {
  const pane = $("#sessions");
  pane.innerHTML = "";
  const label = el("div", "section-label");
  label.appendChild(el("span", null, labelText || "Sessions"));
  label.appendChild(el("span", "count", String(sessions.length)));
  pane.appendChild(label);

  if (sessions.length === 0) {
    pane.appendChild(el("div", "placeholder", "No conversations"));
    return;
  }

  for (const s of sessions) {
    const row = el("div", "row");
    row.appendChild(el("span", "title", cleanTitle(s.title)));
    const meta = el("div", "meta");
    meta.appendChild(el("span", null, fmtRelative(s.created_at)));
    meta.appendChild(el("span", "sep", "·"));
    meta.appendChild(el("span", null, `${s.message_count} msgs`));
    if (s.session_type) {
      const pill = el("span", "pill type", s.session_type);
      meta.appendChild(pill);
    }
    row.appendChild(meta);
    row.onclick = () => selectSession(s.id);
    if (s.id === state.activeSessionId) row.classList.add("active");
    pane.appendChild(row);
  }
}

function cleanTitle(t) {
  // Trim the noisy "(Continued) (Continued)" tails for readability.
  return t.replace(/(\s*\(Continued\))+\s*$/i, " ↩").trim();
}

// ---------- transcript ----------

async function selectSession(sessionId, highlightTerm) {
  state.activeSessionId = sessionId;
  // reflect active state in whichever list is showing
  document.querySelectorAll("#sessions .row").forEach((r) => r.classList.remove("active"));
  const data = await api(`/api/session?id=${encodeURIComponent(sessionId)}`);
  renderTranscript(data, highlightTerm);
}

function renderTranscript(data, term) {
  const pane = $("#transcript");
  pane.innerHTML = "";
  if (!data || !data.session) {
    pane.appendChild(el("div", "placeholder big", "Not found"));
    return;
  }
  const wrap = el("div", "transcript-wrap");

  const header = el("div", "transcript-header");
  header.appendChild(el("h2", null, cleanTitle(data.session.title)));
  const sub = el("div", "transcript-sub");
  sub.appendChild(el("span", null, fmtFull(data.session.created_at)));
  sub.appendChild(el("span", "sep", "·"));
  sub.appendChild(el("span", null, `${data.messages.length} messages`));
  if (data.session.model) {
    sub.appendChild(el("span", "sep", "·"));
    sub.appendChild(el("span", null, data.session.model));
  }
  header.appendChild(sub);

  if (data.repos && data.repos.length) {
    const tags = el("div", "repo-tags");
    for (const r of data.repos) {
      const tag = el("div", "repo-tag");
      tag.innerHTML = `<b>${escapeHtml(r.repo.split("/").pop())}</b> ${r.ref_count}`;
      tags.appendChild(tag);
    }
    header.appendChild(tags);
  }
  wrap.appendChild(header);

  if (data.observations && data.observations.length) {
    for (const o of data.observations) {
      const obs = el("div", "obs");
      obs.innerHTML = `<span class="kind">${escapeHtml(o.kind)}</span>${escapeHtml(o.text)}`;
      wrap.appendChild(obs);
    }
  }

  for (const m of data.messages) {
    const long = m.text.length > 900;
    const msg = el("div", `msg ${m.role}${long ? " collapsed" : ""}`);

    const head = el("div", "msg-head");
    head.appendChild(el("span", "avatar", m.role.slice(0, 1).toUpperCase()));
    head.appendChild(el("span", null, m.role));
    head.appendChild(el("span", "spacer"));
    const copy = el("button", "copy-btn", "copy");
    copy.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(m.text).then(() => {
        copy.textContent = "copied";
        setTimeout(() => (copy.textContent = "copy"), 1200);
      });
    };
    head.appendChild(copy);
    msg.appendChild(head);

    const body = el("div", "body");
    body.innerHTML = renderBody(m.text, term);
    msg.appendChild(body);

    if (long) {
      const toggle = el("div", "toggle", "Show full message");
      toggle.onclick = () => {
        msg.classList.toggle("collapsed");
        toggle.textContent = msg.classList.contains("collapsed") ? "Show full message" : "Collapse";
      };
      msg.appendChild(toggle);
    }
    wrap.appendChild(msg);
  }

  pane.appendChild(wrap);
  pane.scrollTop = 0;
}

// ---------- search ----------

async function runSearch(term) {
  state.mode = "search";
  state.searchTerm = term;
  const scoped = $("#scope-project").checked && state.activeRepo;
  const qs = new URLSearchParams({ q: term });
  if (scoped) qs.set("repo", state.activeRepo);
  const { hits } = await api(`/api/search?${qs.toString()}`);
  renderSearchResults(hits, term, scoped);
}

function renderSearchResults(hits, term, scoped) {
  const pane = $("#sessions");
  pane.innerHTML = "";
  const label = el("div", "section-label");
  label.appendChild(el("span", null, scoped ? `Results in ${state.activeRepoName}` : "Results"));
  label.appendChild(el("span", "count", String(hits.length)));
  pane.appendChild(label);

  if (hits.length === 0) {
    pane.appendChild(el("div", "search-empty", `No matches for “${term}”`));
    return;
  }

  for (const h of hits) {
    const row = el("div", "row");
    row.appendChild(el("span", "title", cleanTitle(h.title)));
    const meta = el("div", "meta");
    meta.innerHTML =
      `<span class="pill">${escapeHtml(h.projectName)}</span>` +
      `<span>${escapeHtml(h.role)}</span>`;
    row.appendChild(meta);
    const snip = el("div", "meta");
    snip.innerHTML = applyHighlight(escapeHtml(h.snippet || "").replace(/\[/g, "").replace(/\]/g, ""), term);
    row.appendChild(snip);
    row.onclick = () => selectSession(h.sessionId, term);
    pane.appendChild(row);
  }
}

// ---------- init ----------

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function init() {
  const input = $("#search-input");
  const onSearch = debounce(() => {
    const term = input.value.trim();
    if (term.length === 0) {
      if (state.activeRepo) selectRepo(state.activeRepo, state.activeRepoName);
      return;
    }
    runSearch(term);
  }, 220);
  input.addEventListener("input", onSearch);
  $("#scope-project").addEventListener("change", () => {
    if (input.value.trim()) runSearch(input.value.trim());
  });

  // "/" focuses search
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
      if (state.activeRepo) selectRepo(state.activeRepo, state.activeRepoName);
    }
  });

  loadHealth();
  loadRepos();
  setInterval(loadHealth, 10000);
}

init();
