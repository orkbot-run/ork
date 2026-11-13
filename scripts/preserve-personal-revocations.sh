#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

# Run only after stopping every application writer and before importing an older database.
set -euo pipefail
umask 077
SOURCE="${1:?usage: preserve-personal-revocations.sh current-appdata staged-appdata}"
DESTINATION="${2:?usage: preserve-personal-revocations.sh current-appdata staged-appdata}"
[[ -d "$DESTINATION" && ! -L "$DESTINATION" ]] || {
  echo "staged appdata must be a directory, not a symlink" >&2
  exit 1
}
validate_revocations() {
  local data="$1" directory file name
  for directory in "$data" "$data/identity" "$data/identity/personal-revocations"; do
    [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || {
      echo "personal revocation paths must be directories, not symlinks" >&2
      return 1
    }
  done
  directory="$data/identity/personal-revocations"
  [[ -d "$directory" ]] || return 0
  shopt -s nullglob dotglob
  for file in "$directory"/*; do
    [[ ! -L "$file" && -f "$file" ]] || {
      echo "personal revocation entries must be regular files" >&2
      return 1
    }
    name="${file##*/}"
    if [[ "$name" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
      cmp -s "$file" <(printf 'revoked\n') || {
        echo "personal revocation marker is unreadable" >&2
        return 1
      }
    elif [[ "$name" =~ ^\.restore-required\.[a-zA-Z0-9]{12}$ ]]; then
      cmp -s "$file" <(printf 'pending\n') || {
        echo "personal restoration marker is unreadable" >&2
        return 1
      }
    elif [[ ! "$name" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$ ]]; then
      echo "personal revocation entry has an invalid name" >&2
      return 1
    fi
  done
  shopt -u nullglob dotglob
}
private_directory() {
  local directory="$1" reference="$2"
  if [[ ! -d "$directory" ]]; then
    mkdir "$directory"
    chown "$(ls -nd "$reference" | awk '{print $3 ":" $4}')" "$directory"
  fi
  chmod 700 "$directory"
}
preserve_revocations() {
  local source="$SOURCE/identity/personal-revocations" destination="$DESTINATION/identity/personal-revocations" file owner barrier
  validate_revocations "$SOURCE"
  validate_revocations "$DESTINATION"
  if [[ -d "$source" && ! "$SOURCE" -ef "$DESTINATION" ]]; then
    # Copy directory ownership without replacing installation keys or other snapshot data.
    tar -cf - --no-recursion -C "$SOURCE" identity identity/personal-revocations | \
      tar -xf - -C "$DESTINATION"
    shopt -s nullglob
    for file in "$source"/*; do
      [[ "$file" != *.tmp ]] || continue
      cp -p "$file" "$destination/"
    done
    shopt -u nullglob
  fi
  private_directory "$DESTINATION/identity" "$DESTINATION"
  private_directory "$destination" "$DESTINATION/identity"
  owner="$(ls -nd "$destination" | awk '{print $3 ":" $4}')"
  shopt -s nullglob
  for file in "$destination"/*; do chmod 600 "$file"; done
  for file in "$destination"/.restore-required.*; do chmod 600 "$file"; chown "$owner" "$file"; done
  shopt -u nullglob
  barrier="$(mktemp "$destination/.restore-required.XXXXXXXXXXXX")"
  printf 'pending\n' > "$barrier"
  chown "$owner" "$barrier"
}

validate_revocations "$SOURCE"
validate_revocations "$DESTINATION"
if [[ -d "$SOURCE" ]]; then SOURCE="$(cd -- "$SOURCE" && pwd -P)"; fi
DESTINATION="$(cd -- "$DESTINATION" && pwd -P)"
preserve_revocations
# Flush the union before any database commit can make the older admissions visible.
sync
