#!/usr/bin/env bash
# kiro-recall one-shot installer. Zero hurdles:
#   1. ensure bun exists (install if missing)
#   2. install deps from the public npm registry
#   3. register kiro-recall in Kiro (global by default; --local for this repo)
#
# Usage:
#   ./install.sh            # global: available in every Kiro session
#   ./install.sh --local    # only the workspace in the current directory
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say() { printf '\033[36m[kiro-recall]\033[0m %s\n' "$1"; }
err() { printf '\033[31m[kiro-recall]\033[0m %s\n' "$1" >&2; }

# 1. bun ------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  say "bun not found — installing…"
  curl -fsSL https://bun.sh/install | bash
  # Make bun available in THIS shell.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
  err "bun still not on PATH. Restart your terminal and re-run."
  exit 1
fi
say "bun: $(bun --version)"

# 2. deps -----------------------------------------------------------------
say "installing dependencies…"
bun install --registry https://registry.npmjs.org >/dev/null
say "dependencies ready"

# 3. register in Kiro -----------------------------------------------------
say "registering with Kiro…"
bun run bin/kiro-recall.ts install "$@"

# 4. warm the index so the UI has data immediately ------------------------
say "scanning existing Kiro conversations…"
bun run bin/kiro-recall.ts scan >/dev/null 2>&1 || true

say "done. Reload Kiro (Developer: Reload Window) and you're set."
say "Browse history at http://127.0.0.1:37800 once Kiro is running."
