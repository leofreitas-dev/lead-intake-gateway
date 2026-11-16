/**
 * Token bucket, one bucket per key.
 * Each bucket holds up to `burst` tokens and refills at `perSecond` tokens a second.
 * A request takes one token; with no token left it is refused and told when to retry.
 * Lives in memory: with several gateway instances, each one limits on its own.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedMs: number }>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(opts: { perSecond: number; burst: number; now?: () => number }) {
    this.perSecond = opts.perSecond;
    this.burst = opts.burst;
    this.now = opts.now ?? Date.now;
  }

  take(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updatedMs: nowMs };
    const refill = ((nowMs - bucket.updatedMs) / 1000) * this.perSecond;
    bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
    bucket.updatedMs = nowMs;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) this.forgetFullBuckets(nowMs);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.perSecond)) };
  }

  /** A bucket that would be full again carries no information; drop it to bound memory. */
  private forgetFullBuckets(nowMs: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((nowMs - b.updatedMs) / 1000) * this.perSecond >= this.burst) this.buckets.delete(key);
    }
  }
}
