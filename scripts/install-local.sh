#!/usr/bin/env bash
#
# Builds the release executable and puts it on PATH for this user.
#
# The everyday loop: change something, run this, run `wisty`. It deliberately
# does not build packages, write a .desktop entry or install icons — that is
# what scripts/package-user-tarball.sh is for, and doing it here would make the
# quick path slow.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="wisty"
RELEASE_BIN="$ROOT_DIR/src-tauri/target/release/$APP_NAME"
BIN_DIR="${WISTY_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/$APP_NAME"

# `tauri build` runs the frontend build itself, through beforeBuildCommand.
# --no-bundle is not passed: bundle.active is already false in tauri.conf.json,
# so nothing is packaged and adding the flag would only hide a change to that.
npm run --prefix "$ROOT_DIR" tauri build

if [ ! -f "$RELEASE_BIN" ]; then
  printf "Error: the build finished but no executable is at '%s'.\n" "$RELEASE_BIN" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

# Written beside the target and renamed over it, rather than copied onto it.
# Overwriting an executable that is currently running fails with "Text file
# busy"; replacing the name unlinks the old file instead, which the running
# copy is welcome to keep using until it exits.
TEMP_TARGET="$(mktemp "$BIN_DIR/.$APP_NAME.XXXXXX")"
trap 'rm -f "$TEMP_TARGET"' EXIT
install -m 755 "$RELEASE_BIN" "$TEMP_TARGET"
mv -f "$TEMP_TARGET" "$TARGET"
trap - EXIT

printf "%s\n" "Installed $APP_NAME to $TARGET"

case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf "\n%s\n" "Note: '$BIN_DIR' is not on your PATH, so '$APP_NAME' will not run by name."
    printf "%s\n" "Add it with: export PATH=\"\$PATH:$BIN_DIR\""
    ;;
esac
