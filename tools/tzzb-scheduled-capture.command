#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
BUNDLED_NODE="/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  exit 1
fi

cd "$PROJECT_DIR"
exec "$NODE_BIN" "$SCRIPT_DIR/tzzb-review-schedule.mjs"
