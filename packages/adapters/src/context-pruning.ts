import type { Message } from "@earendil-works/pi-ai";
import { isMcpImageResultDetails } from "./mcp-result-images.js";

type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

const DEFAULT_TOOL_IMAGES_TO_KEEP = 2;
const SCREENSHOT_REMOVED_NOTE = "[Older screenshot removed; observe again if needed]";
const MCP_IMAGES_REMOVED_NOTE =
  "[Earlier MCP images removed from context. Use the remaining images and text.]";

export class ModelImageLimitError extends Error {}

/**
 * Tools whose result is a view of the current page or screen. Each new result supersedes the
 * earlier ones, so older results only cost context: a long browsing run otherwise re-sends every
 * snapshot it ever took on every model call.
 */
const PAGE_STATE_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "computer_observe",
  "computer_act",
]);
const DEFAULT_PAGE_STATE_RESULTS_TO_KEEP = 3;
/**
 * Only results that actually carry a page (a snapshot tree, an observation) are worth trimming
 * or counting. Navigation confirmations, action receipts and errors are a line or two: trimming
 * them saves nothing, and counting them would push real page state out of the kept set.
 */
const STALE_PAGE_STATE_MIN_CHARS = 1_000;
const STALE_PAGE_STATE_NOTE =
  "[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot.]";

/**
 * Replace all but the most recent large page-state tool results with a short note. The runtime
 * context policy applies this only when it rebuilds a run's transcript, never to a transcript the
 * model has already seen.
 */
export function pruneStalePageStateContext(
  messages: Message[],
  keep = DEFAULT_PAGE_STATE_RESULTS_TO_KEEP,
): Message[] {
  let remaining = Math.max(0, Math.floor(keep));
  let transformed: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" || !PAGE_STATE_TOOL_NAMES.has(message.toolName)) continue;
    // Failures are diagnostics, not fresh page state, even when their text is large.
    const returnedError = (message.details as { error?: unknown } | undefined)?.error;
    if (message.isError || (returnedError !== undefined && returnedError !== null)) continue;
    if (textLength(message) < STALE_PAGE_STATE_MIN_CHARS) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: [{ type: "text", text: STALE_PAGE_STATE_NOTE }],
    };
  }
  return transformed ?? messages;
}

function textLength(message: ToolResultMessage): number {
  let total = 0;
  for (const part of message.content) {
    if (part.type === "text") total += part.text.length;
  }
  return total;
}

/**
 * Keep the latest screenshots and MCP images within an optional model image budget.
 * The runtime applies this on a rebuild, keeping at most two tool images to leave room
 * for more. An older result keeps its text and gains a one-line note.
 */
export function pruneComputerScreenshotContext(
  messages: Message[],
  maxImagesPerPrompt?: number,
): Message[] {
  const imageLimit = normalizedImageLimit(maxImagesPerPrompt);
  let remaining = DEFAULT_TOOL_IMAGES_TO_KEEP;
  if (imageLimit !== undefined) {
    const nonScreenshotImages = messages.reduce(
      (count, message) => (toolImageKind(message) ? count : count + imagePartCount(message)),
      0,
    );
    if (nonScreenshotImages > imageLimit) {
      throw new ModelImageLimitError(
        `The configured model image limit is ${imageLimit}, but the prompt contains ${nonScreenshotImages} non-screenshot images.`,
      );
    }
    remaining = Math.min(remaining, imageLimit - nonScreenshotImages);
  }
  let transformed: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    const kind = toolImageKind(message);
    if (!kind) continue;
    const images = imagePartCount(message);
    if (remaining >= images) {
      remaining -= images;
      continue;
    }
    transformed ??= [...messages];
    // MCP tools can return several images together. Keep the first images from the
    // newest result that fits in part, so its numbered markers still match in order.
    const keptImages = kind === "mcp" ? remaining : 0;
    remaining -= keptImages;
    let seenImages = 0;
    transformed[index] = {
      ...message,
      content: [
        ...message.content.filter((part) => part.type !== "image" || seenImages++ < keptImages),
        { type: "text", text: kind === "mcp" ? MCP_IMAGES_REMOVED_NOTE : SCREENSHOT_REMOVED_NOTE },
      ],
    };
  }
  return transformed ?? messages;
}

/** Drop stale page state and tool images over the default or model limit on rebuild. */
export function pruneForRebuild(messages: Message[], maxImagesPerPrompt?: number): Message[] {
  return pruneComputerScreenshotContext(pruneStalePageStateContext(messages), maxImagesPerPrompt);
}

/** A model's image limit as a whole number, or undefined when it has none or it isn't finite. */
export function normalizedImageLimit(maxImagesPerPrompt?: number): number | undefined {
  if (maxImagesPerPrompt === undefined || !Number.isFinite(maxImagesPerPrompt)) return undefined;
  return Math.max(0, Math.floor(maxImagesPerPrompt));
}

export function imagePartCount(message: Message): number {
  if (!Array.isArray(message.content)) return 0;
  return (message.content as Array<{ type: string }>).filter((part) => part.type === "image")
    .length;
}

function toolImageKind(message: Message): "mcp" | "screenshot" | undefined {
  if (message?.role !== "toolResult" || !message.content.some((part) => part.type === "image")) {
    return;
  }
  const details = message.details;
  if (!details || typeof details !== "object") return;
  if (isMcpImageResultDetails(details)) return "mcp";
  if ("frameId" in details && typeof details.frameId === "string") return "screenshot";
}
