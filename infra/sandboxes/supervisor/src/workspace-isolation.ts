// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type Docker from "dockerode";
import { homeVolumeMatches } from "./computer-spec.js";

/** Existing computers must satisfy the same boundary as a newly created workspace computer. */
export function assertWorkspaceComputerIsolation(
  info: Docker.ContainerInspectInfo,
  storage: { homePath: string; homeVolume?: { name: string; subpath: string } },
) {
  const host = info.HostConfig;
  const mounts = info.Mounts ?? [];
  const home = mounts[0];
  const configured = host.Mounts ?? [];
  const binds = host.Binds ?? [];
  const homeOnly = mounts.length === 1 && home?.Destination === "/home/orkbot" && home.RW === true;
  const expectedHome = storage.homeVolume
    ? home?.Type === "volume" &&
      home.Name === storage.homeVolume.name &&
      binds.length === 0 &&
      configured.length === 1 &&
      homeVolumeMatches(configured, storage.homeVolume)
    : home?.Type === "bind" &&
      home.Source === storage.homePath &&
      configured.length === 0 &&
      binds.length === 1 &&
      [`${storage.homePath}:/home/orkbot`, `${storage.homePath}:/home/orkbot:rw`].includes(
        binds[0]!,
      );
  if (
    !homeOnly ||
    !expectedHome ||
    host.Privileged ||
    host.PidMode ||
    host.IpcMode === "host" ||
    host.IpcMode?.startsWith("container:") ||
    host.NetworkMode === "host" ||
    host.NetworkMode?.startsWith("container:") ||
    (host.Devices?.length ?? 0) > 0 ||
    (host.DeviceRequests?.length ?? 0) > 0 ||
    (host.VolumesFrom?.length ?? 0) > 0 ||
    (host.CapAdd?.length ?? 0) > 0 ||
    !(host.CapDrop ?? []).some((cap: string) => cap.toUpperCase() === "ALL") ||
    !(host.SecurityOpt ?? []).some((option: string) =>
      ["no-new-privileges", "no-new-privileges:true"].includes(option),
    ) ||
    (host.SecurityOpt ?? []).some((option: string) => option.includes("unconfined"))
  ) {
    throw new Error("Workspace computer isolation could not be verified");
  }
}
