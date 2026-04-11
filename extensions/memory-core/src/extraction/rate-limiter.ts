/**
 * Sliding-window rate limiter for auto-capture LLM calls.
 * Tracks timestamps of successful (non-empty) extractions within a rolling hour window.
 */

export type RateLimiterConfig = {
  /** Maximum allowed calls within the rolling window. */
  maxPerHour: number;
};

export class ExtractionRateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerHour: number;

  constructor(config: RateLimiterConfig) {
    this.maxPerHour = config.maxPerHour;
  }

  /** Returns true if another call is allowed right now. */
  canProceed(nowMs: number = Date.now()): boolean {
    this.prune(nowMs);
    return this.timestamps.length < this.maxPerHour;
  }

  /** Record a successful (non-empty) extraction. Empty results should NOT call this. */
  record(nowMs: number = Date.now()): void {
    this.timestamps.push(nowMs);
  }

  /** Remove timestamps older than 1 hour from the window. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - 60 * 60 * 1000;
    // timestamps are always in insertion order (ascending)
    let firstValid = 0;
    while (firstValid < this.timestamps.length && this.timestamps[firstValid] < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this.timestamps.splice(0, firstValid);
    }
  }
}
