#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Summarize timings from a self-hosted Compose stack without printing raw logs."""

import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import re
import subprocess


RUN_FIELDS = {
    "run.execution_started": ("run.pre_run_wait_ms", "run.queue_wait_ms"),
    "run.model_dispatched": ("run.setup_ms",),
    "model.response_headers": ("model.headers_ms",),
    "run.first_response": ("run.first_response_ms",),
    "run.finished": ("run.total_ms",),
}


def read_logs(container, since):
    with subprocess.Popen(
        ["docker", "logs", "--since", since, container],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    ) as process:
        for line in process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                yield event
        if process.wait():
            raise SystemExit(f"Could not read logs from {container}")


def summarize(events):
    durations = defaultdict(list)
    transport_channels = 0

    def add(name, value):
        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
            durations[name].append(value)

    for event in events:
        message = event.get("message")
        if message == "http.request.completed":
            route = event.get("http.route")
            procedure = event.get("rpc.procedure")
            if route == "/health":
                add("api.health", event.get("http.duration_ms"))
            if route == "/rpc/*" or procedure:
                label = "rpc"
                if isinstance(procedure, str) and re.fullmatch(r"[a-zA-Z][\w.]{0,95}", procedure):
                    label = f"rpc.{procedure}"
                add(label, event.get("http.duration_ms"))
                add(f"{label}.session", event.get("rpc.session_ms"))
                add(f"{label}.dispatch", event.get("rpc.dispatch_ms"))
        if isinstance(message, str):
            for field in RUN_FIELDS.get(message, ()):
                add(field, event.get(field))
        logger = event.get("logger")
        if isinstance(logger, str) and logger.startswith("http.log.access"):
            request = event.get("request")
            if (
                isinstance(request, dict)
                and request.get("uri") == "/api/installation-transport/v1"
                and event.get("status") == 101
            ):
                transport_channels += 1
    return durations, transport_channels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", default="30m", help="Docker log window (default: 30m)")
    parser.add_argument("--project", default="orkbot", help="Compose project (default: orkbot)")
    args = parser.parse_args()
    containers = subprocess.check_output(
        [
            "docker", "ps",
            "--filter", f"label=com.docker.compose.project={args.project}",
            "--format", '{{.ID}} {{.Label "com.docker.compose.service"}}',
        ],
        text=True,
    ).splitlines()
    targets = [
        container
        for container, _, service in (row.partition(" ") for row in containers)
        if service in {"api", "worker", "caddy"}
    ]
    if not targets:
        raise SystemExit("No running API, worker or Caddy container found")
    durations, channels = summarize(
        event for target in targets for event in read_logs(target, args.since)
    )
    print(f"Window {args.since} | closed direct installation channels {channels}")
    print(f"{'Metric (ms)':<52} {'n':>6} {'p50':>9} {'p95':>9} {'p99':>9}")
    for metric, values in sorted(durations.items()):
        values.sort()
        percentiles = [values[math.ceil(len(values) * q) - 1] for q in (0.5, 0.95, 0.99)]
        print(f"{metric:<52} {len(values):>6} " + " ".join(f"{v:>9.1f}" for v in percentiles))
    for resource in ("cpu", "memory", "io"):
        pressure = Path(f"/proc/pressure/{resource}")
        if pressure.is_file():
            print(f"Host {resource} pressure | {pressure.read_text().splitlines()[0]}")


if __name__ == "__main__":
    main()
