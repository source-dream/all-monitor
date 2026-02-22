#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${RELEASE_TAG:-}" ]]; then
  echo "[ci-release] RELEASE_TAG is required" >&2
  exit 1
fi

echo "[ci-release] packaging tag: ${RELEASE_TAG}"
VERSION="${RELEASE_TAG}" bash "$ROOT_DIR/scripts/release.sh"
