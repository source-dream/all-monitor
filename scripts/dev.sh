#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev.pids"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    while IFS= read -r pid; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done <"$PID_FILE"
    rm -f "$PID_FILE"
  fi
}

trap cleanup INT TERM EXIT

echo "[dev] starting backend..."
(cd "$ROOT_DIR/server" && go run ./cmd/app) &
BACK_PID=$!

echo "[dev] starting frontend..."
(cd "$ROOT_DIR/web" && npm run dev) &
WEB_PID=$!

printf "%s\n%s\n" "$BACK_PID" "$WEB_PID" >"$PID_FILE"

echo "[dev] backend pid: $BACK_PID"
echo "[dev] frontend pid: $WEB_PID"
echo "[dev] press Ctrl+C to stop both"

wait -n "$BACK_PID" "$WEB_PID"
