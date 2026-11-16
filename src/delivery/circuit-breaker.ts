import type { Gate } from '../queue/worker.ts';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerChange {
  destination: string;
  from: BreakerState;
  to: BreakerState;
  failures: number;
  reason: string;
  cooldownMs: number;
}

/**
 * Circuit breaker for one destination (the CRM), like the breaker in a house's
 * fuse box:
 *
 * - closed: deliveries flow. Each failure that says "the CRM is unwell"
 *   (unreachable, timeout, 5xx) is counted; a success resets the count.
 * - open: after `failureThreshold` failures in a row, deliveries stop for
 *   `cooldownMs`. Jobs stay in the queue and keep their attempts: hammering a
 *   CRM that is down helps nobody and would burn every lead's retries.
 * - half_open: after the cooldown, ONE trial delivery goes through. Success →
 *   closed; failure → open again for another cooldown.
 *
 * It is the worker's gate: while open, no loop takes a job of this destination.
 * In memory, per process: with several workers, each has its own breaker.
 */
export class CircuitBreaker implements Gate {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  readonly destination: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onChange: (change: BreakerChange) => void;

  constructor(opts: {
    destination: string;
    failureThreshold: number;
    cooldownMs: number;
    now?: () => number;
    onChange?: (change: BreakerChange) => void;
  }) {
    this.destination = opts.destination;
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
  }

  get current(): BreakerState {
    return this.state;
  }

  /** How long a loop must wait before taking a job; 0 means go. */
  waitMs(): number {
    if (this.state === 'closed') return 0;
    if (this.state === 'open') {
      const left = this.openedAt + this.cooldownMs - this.now();
      if (left > 0) return left;
      this.move('half_open', 'cooldown is over: one trial delivery');
      this.trialInFlight = true;
      return 0; // this caller makes the trial
    }
    // half_open: only one trial at a time; the others wait for its result.
    if (this.trialInFlight) return 250;
    this.trialInFlight = true;
    return 0;
  }

  /** The loop that was let through found no job: the trial slot is free again. */
  nothingClaimed(): void {
    if (this.state === 'half_open') this.trialInFlight = false;
  }

  /**
   * The trial delivery ended without saying whether the destination is well:
   * a 429 (the CRM is up, just busy), or an error before the call was made.
   * The breaker stays half-open and the next loop may make the trial.
   * Without this, the breaker would wait for that trial's verdict forever.
   */
  releaseTrial(): void {
    if (this.state === 'half_open') this.trialInFlight = false;
  }

  success(): void {
    this.failures = 0;
    this.trialInFlight = false;
    if (this.state !== 'closed') this.move('closed', 'a delivery worked');
  }

  failure(reason: string): void {
    this.failures++;
    if (this.state === 'half_open') {
      this.trialInFlight = false;
      this.openedAt = this.now();
      this.move('open', `the trial delivery failed: ${reason}`);
    } else if (this.state === 'closed' && this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.move('open', `${this.failures} failures in a row, last: ${reason}`);
    }
  }

  private move(to: BreakerState, reason: string): void {
    const from = this.state;
    this.state = to;
    this.onChange({ destination: this.destination, from, to, failures: this.failures, reason, cooldownMs: this.cooldownMs });
  }
}
