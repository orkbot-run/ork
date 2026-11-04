import type { AnalyticsEvent } from "@orkbot/contracts";

/** Optional, best-effort product measurement. Implementations must never throw or block work. */
export interface ProductAnalytics {
  capture(userId: string, event: AnalyticsEvent, identity?: { id: string; at: Date }): void;
  flush(): Promise<void>;
}
