// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: string[]) =>
      strings.reduce((result, part, i) => result + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@orkbot/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
}));

import { SubagentCard } from "./SubagentCard";

function mountCard(
  block: Parameters<typeof SubagentCard>[0]["block"],
  onStop?: () => Promise<void>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<SubagentCard block={block} onStop={onStop} />));
  const get = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const click = () => flushSync(() => toggle()?.click());
  return {
    get,
    toggle,
    click,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

const finished = {
  kind: "subagent" as const,
  agentId: "agent-1",
  name: "writer",
  task: "A long brief",
  status: "completed" as const,
  result: "A long report",
};

describe("SubagentCard", () => {
  it("offers stop only for a running background helper and shows stopped status", async () => {
    const onStop = vi.fn(async () => undefined);
    const foreground = mountCard({ ...finished, status: "running" }, onStop);
    expect(foreground.get("subagent-card")?.textContent).not.toContain("Stop");
    foreground.unmount();
    const stopped = mountCard(
      { ...finished, status: "failed", background: true, stopped: true },
      onStop,
    );
    expect(stopped.get("subagent-card")?.textContent).toContain("Stopped.");
    expect(stopped.get("subagent-card")?.textContent).not.toContain("Failed");
    stopped.unmount();
    const card = mountCard({ ...finished, status: "running", background: true }, onStop);
    const button = [...card.get("subagent-card")!.querySelectorAll("button")].find(
      (item) => item.textContent === "Stop",
    );
    expect(button).toBeDefined();
    expect(button!.getAttribute("aria-label")).toBe("Stop writer");
    flushSync(() => button!.click());
    expect(onStop).toHaveBeenCalledOnce();
    expect(button!.disabled).toBe(true);
    await vi.waitFor(() => expect(button!.disabled).toBe(false));
    flushSync(() => button!.click());
    expect(onStop).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(button!.disabled).toBe(false));
    card.unmount();
  });

  it("shows a failure and permits retry when stopping fails", async () => {
    const onStop = vi.fn(async () => {
      throw new Error("offline");
    });
    const card = mountCard({ ...finished, status: "running", background: true }, onStop);
    const button = [...card.get("subagent-card")!.querySelectorAll("button")].find(
      (item) => item.textContent === "Stop",
    )!;
    flushSync(() => button.click());
    await vi.waitFor(() =>
      expect(card.get("subagent-card")?.querySelector('[role="alert"]')?.textContent).toContain(
        "Try again",
      ),
    );
    expect(button.disabled).toBe(false);
    card.unmount();
  });
  it.each(["running", "completed", "failed"] as const)(
    "labels %s helpers and respects reduced motion",
    (status) => {
      const card = mountCard({ ...finished, agentId: `label-${status}`, status });
      const label =
        status === "running" ? "Running" : status === "completed" ? "Completed" : "Failed";
      expect(card.toggle()?.textContent).toContain(label);
      const pill = [...(card.toggle()?.querySelectorAll("span") ?? [])].find(
        (span) => span.textContent === label,
      );
      expect(pill?.getAttribute("style")).toBeNull();
      if (status === "running") expect(pill?.className).toContain("motion-safe:animate-");
      card.unmount();
    },
  );
  it("starts folded to one line of the task, without the result", () => {
    const card = mountCard({ ...finished, agentId: "agent-folded" });
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.get("subagent-task")?.textContent).toBe("A long brief");
    expect(card.get("subagent-task")?.className).toContain("truncate");
    expect(card.get("subagent-body")).toBeNull();
    expect(card.get("subagent-chevron")?.getAttribute("class")).not.toContain("rotate-180");
    card.unmount();
  });

  it("opens to the full task and result, and folds again", async () => {
    const card = mountCard({ ...finished, agentId: "agent-toggle" });
    flushSync(() => (card.get("subagent-task") as HTMLElement).click());
    expect(card.get("subagent-chevron")?.getAttribute("class")).toContain("rotate-180");
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.get("subagent-task")?.className).not.toContain("truncate");
    expect(card.get("subagent-body")?.textContent).toBe("A long report");

    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.get("subagent-task")?.className).toContain("truncate");
    await vi.waitFor(() => expect(card.get("subagent-body")).toBeNull());
    card.unmount();
  });

  it("shows progress when opened while the helper runs", () => {
    const card = mountCard({
      ...finished,
      agentId: "agent-progress",
      status: "running",
      result: undefined,
      progress: "Reading files",
    });
    expect(card.get("subagent-card")?.textContent).toContain("Running");
    expect(card.get("subagent-body")).toBeNull();
    card.click();
    expect(card.get("subagent-body")?.textContent).toBe("Reading files");
    card.unmount();
  });

  it("has no body before the helper reports anything", () => {
    const card = mountCard({
      ...finished,
      agentId: "agent-silent",
      status: "running",
      result: undefined,
    });
    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.get("subagent-body")).toBeNull();
    card.unmount();
  });

  it("stays open when the saved message replaces the live card", () => {
    const running = mountCard({
      ...finished,
      agentId: "agent-saved",
      status: "running",
      result: undefined,
      progress: "Reading files",
    });
    running.click();
    running.unmount();

    const saved = mountCard({ ...finished, agentId: "agent-saved" });
    expect(saved.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(saved.get("subagent-body")?.textContent).toBe("A long report");
    saved.unmount();
  });
});
