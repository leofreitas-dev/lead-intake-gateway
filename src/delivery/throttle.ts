/**
 * Our own speed limit towards one destination: a token bucket that WAITS for
 * a token instead of refusing (the gateway's limiter refuses; here the job is
 * already ours, so it waits its turn). `perSecond` is kept below the CRM's own
 * limit, so in normal operation the CRM never has to answer 429.
 *
 * When the CRM says 429 anyway, pauseFor(Retry-After) holds every delivery,
 * not only the one that got the 429.
 */
export class Throttle {
  private tokens: number;
  private updatedMs: number;
  private pausedUntil = 0;
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { perSecond: number; burst: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.perSecond = opts.perSecond;
    this.burst = opts.burst;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tokens = opts.burst;
    this.updatedMs = this.now();
  }

  /** Resolves when a call may go out. Returns how long it waited, in ms. */
  async acquire(): Promise<number> {
    const started = this.now();
    for (;;) {
      const now = this.now();
      if (this.pausedUntil > now) {
        await this.sleep(this.pausedUntil - now);
        continue;
      }
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.updatedMs) / 1000) * this.perSecond);
      this.updatedMs = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return this.now() - started;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
    }
  }

  /** The destination asked us to wait: nobody calls it before then. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}
