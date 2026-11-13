// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { containerCreateOptions } from "./computer-spec.js";
import { assertWorkspaceComputerIsolation } from "./workspace-isolation.js";

function computer(volume = false) {
  const storage = {
    homePath: "/fixture/homes/computer",
    ...(volume ? { homeVolume: { name: "data", subpath: "homes/computer" } } : {}),
  };
  const options = containerCreateOptions({
    ...storage,
    name: "computer",
    image: "fixture",
    botId: "computer",
    spaceId: "space",
    networkMode: "orkbot-computer",
  });
  const info = {
    Config: options,
    HostConfig: options.HostConfig,
    Mounts: [
      {
        Destination: "/home/orkbot",
        RW: true,
        ...(volume
          ? { Type: "volume", Name: "data", Source: "/var/lib/docker/volumes/data/_data" }
          : { Type: "bind", Source: storage.homePath }),
      },
    ],
  } as unknown as Docker.ContainerInspectInfo;
  return { storage, info };
}

describe("workspace computer isolation", () => {
  it.each([false, true])("accepts only the computer's own home (volume: %s)", (volume) => {
    const { storage, info } = computer(volume);
    expect(() => assertWorkspaceComputerIsolation(info, storage)).not.toThrow();
  });
  it.each([
    [
      "additional bind",
      (info: Docker.ContainerInspectInfo) => {
        info.Mounts.push({
          Type: "bind",
          Source: "/shared",
          Destination: "/shared",
          RW: true,
        } as Docker.ContainerInspectInfo["Mounts"][number]);
      },
    ],
    [
      "additional volume",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.Mounts = [{ Type: "volume", Source: "shared", Target: "/shared" }];
      },
    ],
    [
      "another home",
      (info: Docker.ContainerInspectInfo) => {
        info.Mounts[0]!.Source = "/fixture/homes/another";
      },
    ],
    [
      "privileged mode",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.Privileged = true;
      },
    ],
    [
      "host PID",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.PidMode = "host";
      },
    ],
    [
      "host IPC",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.IpcMode = "host";
      },
    ],
    [
      "shared IPC",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.IpcMode = "container:other";
      },
    ],
    [
      "host network",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.NetworkMode = "host";
      },
    ],
    [
      "host device",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.Devices = [
          { PathOnHost: "/dev/host", PathInContainer: "/dev/host", CgroupPermissions: "rwm" },
        ];
      },
    ],
    [
      "inherited volumes",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.VolumesFrom = ["another"];
      },
    ],
    [
      "additional capability",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.CapAdd = ["SYS_ADMIN"];
      },
    ],
    [
      "retained capabilities",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.CapDrop = [];
      },
    ],
    [
      "privilege escalation",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.SecurityOpt = [];
      },
    ],
    [
      "unconfined execution",
      (info: Docker.ContainerInspectInfo) => {
        info.HostConfig.SecurityOpt!.push("seccomp=unconfined");
      },
    ],
  ] as const)("refuses existing computer with %s", (_name, mutate) => {
    const { storage, info } = computer();
    mutate(info);
    expect(() => assertWorkspaceComputerIsolation(info, storage)).toThrow("isolation");
  });
  it.each(["", "homes/another", "."])(
    "refuses a shared or different volume subpath: %s",
    (subpath) => {
      const { storage, info } = computer(true);
      info.HostConfig.Mounts![0]!.VolumeOptions!.Subpath = subpath;
      expect(() => assertWorkspaceComputerIsolation(info, storage)).toThrow("isolation");
    },
  );
});
