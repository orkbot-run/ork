#!/bin/sh
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

# Keep the entry point POSIX-compatible: it is also executed by `curl ... | sh`.
ork_install() {
  set +x
  set -eu

  revision=''
  revision_set=false
  code_stdin=false
  code_argument=false
  remaining=$#
  while [ "$remaining" -gt 0 ]; do
    case "$1" in
      --revision)
        [ "$remaining" -ge 2 ] || { echo 'Ork setup failed: --revision requires a commit SHA.' >&2; return 2; }
        [ "$revision_set" = false ] || { echo 'Ork setup failed: --revision may be provided only once.' >&2; return 2; }
        revision=$2
        revision_set=true
        shift 2
        remaining=$((remaining - 2))
        ;;
      --code|--url)
        [ "$remaining" -ge 2 ] || { echo "Ork setup failed: $1 requires a value." >&2; return 2; }
        [ "$1" != --code ] || code_argument=true
        set -- "$@" "$1" "$2"
        shift 2
        remaining=$((remaining - 2))
        ;;
      --code-stdin)
        code_stdin=true
        shift
        remaining=$((remaining - 1))
        ;;
      *)
        set -- "$@" "$1"
        shift
        remaining=$((remaining - 1))
        ;;
    esac
  done

  if [ "$revision_set" = true ]; then
    case "$revision" in
      *[!0-9a-f]*|'') echo 'Ork setup failed: --revision must be a lowercase commit SHA.' >&2; return 2 ;;
    esac
    [ "${#revision}" -eq 40 ] || { echo 'Ork setup failed: --revision must be a 40-character commit SHA.' >&2; return 2; }
  fi
  [ "$code_argument" = false ] || [ "$code_stdin" = false ] || { echo 'Ork setup failed: use either --code or --code-stdin.' >&2; return 2; }
  [ -n "${HOME:-}" ] || { echo 'Ork setup failed: HOME is not set.' >&2; return 1; }
  command -v curl >/dev/null 2>&1 || { echo 'Ork setup failed: curl is required.' >&2; return 1; }
  command -v bash >/dev/null 2>&1 || { echo 'Ork setup failed: bash is required.' >&2; return 1; }

  umask 077
  mkdir -p -m 700 "$HOME/orkbot"
  cd "$HOME/orkbot"
  if [ "$code_stdin" = true ] || { [ "$code_argument" = false ] && [ ! -f .env ]; }; then
    if ! (: </dev/tty) 2>/dev/null; then
      echo 'Ork setup failed: an installation code and an interactive terminal are required for a new server.' >&2
      return 1
    fi
    command -v stty >/dev/null 2>&1 || { echo 'Ork setup failed: stty is required to read the installation code.' >&2; return 1; }
    tty_settings=$(stty -g </dev/tty) || return 1
    trap 'stty "$tty_settings" </dev/tty 2>/dev/null || :' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    stty -echo </dev/tty || return 1
    printf 'Installation code: ' >/dev/tty
    read_ok=true
    IFS= read -r code </dev/tty || read_ok=false
    stty "$tty_settings" </dev/tty || return 1
    printf '\n' >/dev/tty
    trap - EXIT HUP INT TERM
    [ "$read_ok" = true ] || { echo 'Ork setup failed: no installation code was provided.' >&2; return 1; }
    case "$code" in
      *[!A-Za-z0-9_-]*|'') echo 'Ork setup failed: the installation code has an invalid format.' >&2; return 1 ;;
    esac
    [ "${#code}" -eq 43 ] || { echo 'Ork setup failed: the installation code has an invalid format.' >&2; return 1; }
    code_stdin=true
  fi
  ork_runtime=$(mktemp -d)
  trap 'rm -rf -- "$ork_runtime"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -f .env ]; then
    [ ! -L .env ] || { echo 'Ork setup failed: .env must not be a symlink.' >&2; return 1; }
    tag=$(awk '
      /^[[:space:]]*(export[[:space:]]+)?ORKBOT_IMAGE_TAG[[:space:]]*=/ {
        line=$0
        sub(/^[[:space:]]*(export[[:space:]]+)?ORKBOT_IMAGE_TAG[[:space:]]*=/, "", line)
        sub(/^[[:space:]]+/, "", line); sub(/[[:space:]\r]+$/, "", line)
        q=sprintf("%c",39)
        if ((substr(line,1,1)==q && substr(line,length(line),1)==q) || (substr(line,1,1)=="\"" && substr(line,length(line),1)=="\"")) line=substr(line,2,length(line)-2)
        value=line; count++
      }
      END { if (count != 1) exit 1; print value }
    ' .env) || tag=''
    installed_revision=''
    case "$tag" in
      sha-*) installed_revision=${tag#sha-} ;;
    esac
    case "$installed_revision" in
      *[!0-9a-f]*|'') installed_revision='' ;;
    esac
    [ "${#installed_revision}" -eq 40 ] || installed_revision=''
    if [ -n "$installed_revision" ]; then
      if [ "$revision_set" = true ] && [ "$revision" != "$installed_revision" ]; then
        echo 'Ork setup failed: --revision does not match the installed image version.' >&2
        return 1
      fi
      revision=$installed_revision
      revision_set=true
    elif [ "$revision_set" = false ]; then
      echo 'Ork setup failed: the installed image is not pinned to a commit; provide --revision.' >&2
      return 1
    fi
  fi
  if [ "$revision_set" = false ]; then
    command -v python3 >/dev/null 2>&1 || { echo 'Ork setup failed: python3 is required to find the latest release; alternatively provide --revision.' >&2; return 1; }
    curl -fsSL --connect-timeout 15 --max-time 60 --proto '=https' --proto-redir '=https' -H 'User-Agent: Ork-Installer' -o "$ork_runtime/channel.json" 'https://api.github.com/repos/orkbot-run/ork/releases/tags/desktop-preview' || {
      echo 'Ork setup failed: could not retrieve the release channel.' >&2; return 1;
    }
    asset=$(python3 -c '
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as source: release = json.load(source)
    if release.get("tag_name") != "desktop-preview" or release.get("draft") is not False: raise ValueError()
    assets = [a.get("url") for a in release.get("assets", []) if isinstance(a, dict) and a.get("name") == "latest.json"]
    if len(assets) != 1 or not isinstance(assets[0], str) or not re.fullmatch(r"https://api\.github\.com/repos/orkbot-run/ork/releases/assets/[0-9]+", assets[0]): raise ValueError()
    print(assets[0])
except (ValueError, TypeError, AttributeError, OSError): sys.exit(1)
' "$ork_runtime/channel.json") || { echo 'Ork setup failed: the release channel metadata is invalid.' >&2; return 1; }
    curl -fsSL --connect-timeout 15 --max-time 60 --proto '=https' --proto-redir '=https' -H 'User-Agent: Ork-Installer' -H 'Accept: application/octet-stream' -o "$ork_runtime/latest.json" "$asset" || {
      echo 'Ork setup failed: could not retrieve the release manifest.' >&2; return 1;
    }
    version=$(python3 -c '
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as source: manifest = json.load(source)
    version = manifest.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version): raise ValueError()
    print(version)
except (ValueError, TypeError, AttributeError, OSError): sys.exit(1)
' "$ork_runtime/latest.json") || { echo 'Ork setup failed: the release manifest is invalid.' >&2; return 1; }
    curl -fsSL --connect-timeout 15 --max-time 60 --proto '=https' --proto-redir '=https' -H 'User-Agent: Ork-Installer' -o "$ork_runtime/release.json" "https://api.github.com/repos/orkbot-run/ork/releases/tags/desktop-preview-$version" || {
      echo 'Ork setup failed: could not retrieve the promoted release.' >&2; return 1;
    }
    revision=$(python3 -c '
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as source: release = json.load(source)
    sha = release.get("target_commitish")
    if release.get("tag_name") != "desktop-preview-" + sys.argv[2] or release.get("draft") is not False or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha): raise ValueError()
    print(sha)
except (ValueError, TypeError, AttributeError, OSError): sys.exit(1)
' "$ork_runtime/release.json" "$version") || { echo 'Ork setup failed: the promoted release metadata is invalid.' >&2; return 1; }
  fi
  base="https://raw.githubusercontent.com/orkbot-run/ork/$revision/infra/compose"
  ork_installer="$ork_runtime/install-images.sh"
  curl -fsSL --connect-timeout 15 --max-time 120 --proto '=https' --proto-redir '=https' -o "$ork_installer" "$base/install-images.sh" || {
    echo 'Ork setup failed: could not download the installer.' >&2; return 1;
  }
  if [ "$code_stdin" = true ]; then
    printf '%s\n' "$code" | ORKBOT_DOWNLOAD_BASE="$base" bash "$ork_installer" --server "$@" --code-stdin
    unset code
  else
    ORKBOT_DOWNLOAD_BASE="$base" bash "$ork_installer" --server "$@"
  fi
}

ork_install "$@"
