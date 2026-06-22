#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Install the agent-system pi extensions (subagents engine + main-session extensions).
#
# Generic: each extension reads the project's config from <repoRoot>/harness/checks.json,
# so a SINGLE installed copy serves every repo that ships a harness/ skeleton. Run once
# per machine.
#
# Every immediate subdirectory of harness/pi/ that contains an index.ts is installed as its
# own pi extension under ~/.pi/agent/extensions/<name> (subagents, command-guard,
# secret-redaction, checks, boundary-instructions, …). The shared/ dir (no index.ts, not an
# extension) holds modules imported by extensions via "../shared/"; it is installed alongside
# them so those relative imports resolve in BOTH symlink and --copy modes.
#
# Usage:
#   harness/pi/install.sh            # symlink every extension (default; edits in-repo apply live)
#   harness/pi/install.sh --copy     # copy instead of symlink (no link back to the repo)
#   harness/pi/install.sh --uninstall
#
# After installing, run /reload inside pi (or restart) to pick up the commands.

set -euo pipefail

SRC_PARENT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_PARENT="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"

mode="symlink"
for arg in "$@"; do
  case "$arg" in
    --copy) mode="copy" ;;
    --uninstall) mode="uninstall" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# The set of extension names = every harness/pi/*/ dir that has an index.ts.
extension_names() {
  local d
  for d in "$SRC_PARENT"/*/; do
    [[ -f "${d}index.ts" ]] && basename "$d"
  done
}

# Install (or uninstall) one target dir (an extension, or the shared/ module dir).
install_one() {
  local name="$1"
  local src="$2"
  local dest="$DEST_PARENT/$name"
  # Back up any existing real directory (not our own symlink) before replacing it.
  if [[ -e "$dest" && ! -L "$dest" ]]; then
    local bak="$dest.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$dest" "$bak"
    echo "backed up existing $name -> $bak"
  elif [[ -L "$dest" ]]; then
    rm -f "$dest"
  fi
  if [[ "$mode" == "symlink" ]]; then
    ln -s "$src" "$dest"
    echo "symlinked $dest -> $src"
  else
    cp -r "$src" "$dest"
    echo "copied $name -> $dest"
  fi
}

uninstall_one() {
  local name="$1"
  local dest="$DEST_PARENT/$name"
  if [[ -e "$dest" || -L "$dest" ]]; then rm -rf "$dest"; echo "removed $dest"; else echo "nothing at $dest"; fi
}

if [[ "$mode" == "uninstall" ]]; then
  while IFS= read -r name; do
    [[ -n "$name" ]] && uninstall_one "$name"
  done < <(extension_names)
  [[ -d "$SRC_PARENT/shared" ]] && uninstall_one "shared"
  echo "Run /reload in pi to drop the commands."
  exit 0
fi

mkdir -p "$DEST_PARENT"

# Install the shared module dir first (extensions import it via ../shared/).
# Symlink installs resolve ../shared via the link target's real path; copy installs need
# their own copy here so ../shared/checks-core.js and ../shared/redact.js resolve.
if [[ -d "$SRC_PARENT/shared" ]]; then
  install_one "shared" "$SRC_PARENT/shared"
fi

# Install each extension.
count=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  install_one "$name" "$SRC_PARENT/$name"
  count=$((count + 1))
done < <(extension_names)

echo
echo "Installed $count extension(s). They read each repo's harness/checks.json at run time."
echo "Open pi in a harnessed repo and run /reload, then use /plan, /verify, /checks, /monitor, /triage, /report, /research."
echo
echo "Optional companion — ponytail (lazy-senior-dev reuse discipline; main session only):"
echo "  pi install git:github.com/DietrichGebert/ponytail   # then /ponytail [lite|full|ultra|off], /ponytail-review"
