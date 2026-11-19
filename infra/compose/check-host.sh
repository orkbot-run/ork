#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
# SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
# Inherited checks are preserved. Host pressure checks follow LICENSE.md.
set -euo pipefail
messages=()
report() { messages+=("$1"); echo "$1" >&2; }

# CPU PSI measures work waiting for CPU. Load average also includes waits for I/O.
if [[ -r /proc/pressure/cpu ]]; then
  cpu_pressure="$(awk '$1 == "some" { for (i=2; i<=NF; i++) if ($i ~ /^avg300=/) { split($i,a,"="); if (a[2]+0 >= 50) print a[2] } }' /proc/pressure/cpu)"
  [[ -z "${cpu_pressure}" ]] || report "CPU pressure is high (${cpu_pressure}% stalled over 5 minutes)"
elif [[ -r /proc/loadavg ]] && cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null)" && [[ "${cores}" =~ ^[1-9][0-9]*$ ]]; then
  load="$(awk -v cores="${cores}" '$3+0 > cores { print $3 }' /proc/loadavg)"
  [[ -z "${load}" ]] || report "CPU load is high (${load} over 15 minutes on ${cores} CPUs)"
fi
if [[ -r /proc/meminfo ]]; then
  low_memory="$(awk '
    $1 == "MemTotal:" { total = $2 }
    $1 == "MemAvailable:" { available = $2 }
    $1 == "SwapTotal:" { swap = $2 }
    $1 == "SwapFree:" { swap_free = $2 }
    END {
      used = swap - swap_free
      if (total > 0 && (available != "" && available * 10 < total || used > 1024 * 1024))
        printf "%.1f%% available, %d MiB swap used", available * 100 / total, used / 1024
    }' /proc/meminfo)"
  [[ -z "${low_memory}" ]] || report "Memory is under pressure (${low_memory})"
fi

for target in / /var/backups; do
  if ! usage="$(df -Pk "${target}" | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }')" || [[ -z "${usage}" ]]; then
    report "Could not inspect storage at ${target}"
    continue
  fi
  read -r free_kb used <<<"${usage}"
  if ((used >= 80 || free_kb < 5 * 1024 * 1024)); then
    echo "${target}: ${used}% used, $((free_kb / 1024))MiB free" >&2
    report "${target} storage is low (at least 80% used or less than 5GiB free)"
  fi
done
if [[ "${ORKBOT_BACKUP_REQUIRE_VOLUME:-0}" == 1 ]] && { ! mountpoint -q /var/backups || [[ "$(stat -c %d /var/backups)" == "$(stat -c %d /)" ]]; }; then
  report "Backup volume is not mounted separately"
fi
latest=""
if [[ -d /var/backups/orkbot ]]; then
  if ! latest="$(find /var/backups/orkbot -mindepth 2 -maxdepth 2 -name SHA256SUMS -type f -printf '%T@ %h\n' | sort -nr | head -1)"; then
    report "Could not inspect backup history"
  fi
fi
latest_time="${latest%% *}"
if [[ -z "${latest}" ]] || (($(date +%s) - ${latest_time%.*} > 36 * 3600)); then
  report "No verified backup completed in the last 36 hours"
elif [[ -e "${latest#* }/orkbot.dump" && "${ORKBOT_BACKUP_ALLOW_PLAINTEXT:-0}" != 1 ]]; then
  report "The latest backup is not encrypted; set ORKBOT_BACKUP_AGE_RECIPIENTS"
fi
if systemctl is-failed --quiet orkbot-backup.service; then
  report "The last backup service run failed"
else
  /usr/local/sbin/orkbot-host-alert backup-failure "" || report "Could not deliver backup recovery notification"
fi
if ! ports="$(/usr/sbin/sshd -T | awk '$1 == "port" { print $2 }')" || [[ -z "${ports}" ]]; then
  report "Could not inspect SSH configuration"
else
  for port in ${ports}; do
    if ! grep -qE "^### tuple ### (limit|allow) (tcp|any) ${port} " /etc/ufw/user.rules; then
      report "IPv4 SSH allow rule is missing for port ${port}"
    fi
  done
fi

if [[ -e /run/reboot-required ]]; then
  report "Installed updates need a reboot to take effect"
fi

if grep -q '^ORKBOT_AUDIT_SINK_URL=.' /etc/orkbot/audit-ship.env 2>/dev/null && ! systemctl is-active --quiet orkbot-audit-ship.service; then
  report "Audit trail shipping is not running"
fi

# Opt-in because self-hosted Compose project names are chosen by the operator.
if [[ -n "${ORKBOT_MONITOR_COMPOSE_PROJECT:-}" ]]; then
  if ! service_health="$(/usr/local/sbin/orkbot-check-services "${ORKBOT_MONITOR_COMPOSE_PROJECT}")"; then
    report "${service_health:-Could not inspect application container health}"
  fi
fi

printf '%s\n' "${messages[@]}" | /usr/local/sbin/orkbot-host-alert host-check
((${#messages[@]} == 0))
