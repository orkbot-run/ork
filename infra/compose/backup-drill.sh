#!/usr/bin/env bash
# Verify the dump and appdata archive from either deployment layout.
# Encrypted snapshots need an age identity; plaintext is streamed, never staged.
set -euo pipefail
SNAPSHOT="${1:?usage: backup-drill.sh SNAPSHOT_DIR [AGE_IDENTITY_FILE]}"
IDENTITY="${2:-}"
for tool in pg_restore sha256sum tar; do
  command -v "${tool}" >/dev/null || { echo "${tool} is required" >&2; exit 1; }
done

(cd "${SNAPSHOT}" && sha256sum --check --quiet SHA256SUMS)
read_artifact() {
  local name="$1"
  if [[ -f "${SNAPSHOT}/${name}.age" ]]; then
    [[ -n "${IDENTITY}" ]] || { echo "AGE_IDENTITY_FILE is required for encrypted backups" >&2; return 1; }
    command -v age >/dev/null || { echo "age is required for encrypted backups" >&2; return 1; }
    age --decrypt -i "${IDENTITY}" "${SNAPSHOT}/${name}.age"
  else
    cat "${SNAPSHOT}/${name}"
  fi
}
# Read each stream to its end so age authenticates every chunk, when encrypted.
read_artifact orkbot.dump | { pg_restore --list >/dev/null && cat >/dev/null; }
read_artifact appdata.tgz | { tar -tzf - >/dev/null && cat >/dev/null; }
if [[ -f "${SNAPSHOT}/orkbot.dump.age" ]]; then
  echo "Backup ${SNAPSHOT} decrypts and verifies"
else
  echo "Backup ${SNAPSHOT} verifies"
fi
