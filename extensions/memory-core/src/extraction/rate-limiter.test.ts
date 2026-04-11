import { describe, expect, it } from "vitest";
import { ExtractionRateLimiter } from "./rate-limiter.js";

describe("ExtractionRateLimiter", () => {
  const HOUR_MS = 60 * 60 * 1000;

  it("allows calls within limit", () => {
    const limiter = new ExtractionRateLimiter({ maxPerHour: 3 });
    const now = Date.now();
    expect(limiter.canProceed(now)).toBe(true);
    limiter.record(now);
    expect(limiter.canProceed(now)).toBe(true);
    limiter.record(now + 1000);
    expect(limiter.canProceed(now + 2000)).toBe(true);
    limiter.record(now + 2000);
    // At limit
    expect(limiter.canProceed(now + 3000)).toBe(false);
  });

  it("prunes old entries and allows new calls", () => {
    const limiter = new ExtractionRateLimiter({ maxPerHour: 2 });
    const base = 1000000;
    limiter.record(base);
    limiter.record(base + 1000);
    expect(limiter.canProceed(base + 2000)).toBe(false);

    // After 1 hour, old entries pruned
    expect(limiter.canProceed(base + HOUR_MS + 1)).toBe(true);
  });

  it("handles empty state", () => {
    const limiter = new ExtractionRateLimiter({ maxPerHour: 20 });
    expect(limiter.canProceed()).toBe(true);
  });
});
