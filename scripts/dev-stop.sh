#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev.pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "[dev-stop] no pid file found"
  exit 0
fi

while IFS= read -r pid; do
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "[dev-stop] stopped pid $pid"
  fi
done <"$PID_FILE"

rm -f "$PID_FILE"
