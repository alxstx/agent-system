#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Install the Planner -> Implement -> Verify subagents engine into pi.
#
# The engine is generic: it reads each project's checks from
# <repoRoot>/harness/checks.json, so a SINGLE installed copy serves every repo
# that ships a harness/ skeleton. Run this once per machine.
#
# Usage:
#   harness/pi/install.sh            # symlink the engine (default; edits in-repo apply live)
#   harness/pi/install.sh --copy     # copy instead of symlink (no link back to the repo)
#   harness/pi/install.sh --uninstall
#
# After installing, run /reload inside pi (or restart) to pick up the commands.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/subagents" && pwd)"
DEST_PARENT="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
DEST="$DEST_PARENT/subagents"

mode="symlink"
for arg in "$@"; do
  case "$arg" in
    --copy) mode="copy" ;;
    --uninstall) mode="uninstall" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$mode" == "uninstall" ]]; then
  if [[ -e "$DEST" || -L "$DEST" ]]; then rm -rf "$DEST"; echo "removed $DEST"; else echo "nothing at $DEST"; fi
  echo "Run /reload in pi to drop the commands."
  exit 0
fi

mkdir -p "$DEST_PARENT"

# Back up any existing real directory (not our own symlink) before replacing it.
if [[ -e "$DEST" && ! -L "$DEST" ]]; then
  bak="$DEST.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$DEST" "$bak"
  echo "backed up existing engine -> $bak"
elif [[ -L "$DEST" ]]; then
  rm -f "$DEST"
fi

if [[ "$mode" == "symlink" ]]; then
  ln -s "$SRC_DIR" "$DEST"
  echo "symlinked $DEST -> $SRC_DIR"
else
  cp -r "$SRC_DIR" "$DEST"
  echo "copied engine -> $DEST"
fi

echo
echo "Installed. The engine reads each repo's harness/checks.json at run time."
echo "Open pi in a harnessed repo and run /reload, then use /plan and /verify."
