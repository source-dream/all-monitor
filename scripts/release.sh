#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/bin"
DIST_DIR="$ROOT_DIR/dist"

resolve_version() {
  if [[ -n "${VERSION:-}" ]]; then
    echo "$VERSION"
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "snapshot-$(date +%Y%m%d-%H%M%S)"
    return
  fi

  local head_tag latest_tag short_sha dirty_suffix
  head_tag="$(git -C "$ROOT_DIR" tag --points-at HEAD | head -n 1 || true)"
  latest_tag="$(git -C "$ROOT_DIR" describe --abbrev=0 --tags 2>/dev/null || true)"
  short_sha="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  dirty_suffix=""
  if ! git -C "$ROOT_DIR" diff --quiet --ignore-submodules -- 2>/dev/null || ! git -C "$ROOT_DIR" diff --cached --quiet --ignore-submodules -- 2>/dev/null; then
    dirty_suffix="-dirty"
  fi

  if [[ -n "$head_tag" ]]; then
    echo "${head_tag}${dirty_suffix}"
    return
  fi

  if [[ -n "$latest_tag" ]]; then
    echo "${latest_tag}-${short_sha}${dirty_suffix}"
    return
  fi

  echo "snapshot-${short_sha}${dirty_suffix}"
}

VERSION="$(resolve_version)"

mkdir -p "$DIST_DIR"

echo "[release] version: $VERSION"
echo "[release] building linux binary..."
make -C "$ROOT_DIR" APP_VERSION="$VERSION" build-linux

echo "[release] building windows binary..."
if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  make -C "$ROOT_DIR" APP_VERSION="$VERSION" build-windows
else
  echo "[release] mingw not found, skip windows build"
fi

rm -rf "$DIST_DIR/$VERSION"
mkdir -p "$DIST_DIR/$VERSION"

if [[ -f "$BIN_DIR/all-monitor-linux-amd64" ]]; then
  cp "$BIN_DIR/all-monitor-linux-amd64" "$DIST_DIR/$VERSION/all-monitor"
  tar -czf "$DIST_DIR/all-monitor-${VERSION}-linux-amd64.tar.gz" -C "$DIST_DIR/$VERSION" all-monitor
fi

if [[ -f "$BIN_DIR/all-monitor-windows-amd64.exe" ]]; then
  cp "$BIN_DIR/all-monitor-windows-amd64.exe" "$DIST_DIR/$VERSION/all-monitor.exe"
  (cd "$DIST_DIR/$VERSION" && zip -q "$DIST_DIR/all-monitor-${VERSION}-windows-amd64.zip" all-monitor.exe)
fi

cd "$DIST_DIR"
sha256sum "all-monitor-${VERSION}-"* > "SHA256SUMS-${VERSION}.txt"

echo "[release] done"
ls -lh "all-monitor-${VERSION}-"* "SHA256SUMS-${VERSION}.txt"
