import { RESPONSE_STREAMING_STORAGE_KEY } from "@orkbot/core";
import { describe, expect, it } from "vitest";
import {
  persistResponseStreamingPreference,
  resolveResponseStreamingPreference,
} from "./response-streaming";

describe("response streaming preference", () => {
  it("defaults to streaming on and preserves saved off or malformed choices", () => {
    expect(resolveResponseStreamingPreference({ stored: "on" })).toBe("on");
    expect(resolveResponseStreamingPreference({ stored: "off" })).toBe("off");
    expect(resolveResponseStreamingPreference({ stored: null })).toBe("on");
    expect(resolveResponseStreamingPreference({ stored: "" })).toBe("off");
    expect(resolveResponseStreamingPreference({ stored: "invalid" })).toBe("off");
    expect(resolveResponseStreamingPreference({ storage: { getItem: () => null } })).toBe("on");
  });

  it("persists through storage helpers", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    persistResponseStreamingPreference("on", storage);
    expect(store.get(RESPONSE_STREAMING_STORAGE_KEY)).toBe("on");
    expect(resolveResponseStreamingPreference({ storage })).toBe("on");
  });
});
