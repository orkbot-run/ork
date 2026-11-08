#!/bin/sh
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
set -eu

version="${1:?GitHub CLI version is required}"
architecture="${2:?Target architecture is required}"
destination="${3:?Destination is required}"
case "$architecture" in
  amd64) checksum=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be; asset=542974264 ;;
  arm64) checksum=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961; asset=542974279 ;;
  *) echo "unsupported architecture: $architecture" >&2; exit 1 ;;
esac
[ "$version" = 2.100.0 ] || { echo "unsupported GitHub CLI version: $version" >&2; exit 1; }
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
# Both endpoints serve the same pinned upstream asset; the digest is always checked before extraction.
if ! curl -fsSL --retry 2 --retry-all-errors --retry-max-time 180 --connect-timeout 10 --max-time 60 \
  "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_${architecture}.tar.gz" -o "$archive"; then
  curl -fsSL --retry 2 --retry-all-errors --retry-max-time 180 --connect-timeout 10 --max-time 60 \
    -H 'Accept: application/octet-stream' \
    "https://api.github.com/repos/cli/cli/releases/assets/${asset}" -o "$archive"
fi
echo "$checksum  $archive" | sha256sum -c -
tar -xzf "$archive" -C "$destination" --strip-components=2 "gh_${version}_linux_${architecture}/bin/gh"
