import { describe, expect, it } from 'vitest';
import { type BreakerChange, CircuitBreaker } from '../src/delivery/circuit-breaker.ts';
import { Throttle } from '../src/delivery/throttle.ts';

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('CircuitBreaker', () => {
  const make = () => {
    const c = clock();
    const changes: BreakerChange[] = [];
    const breaker = new CircuitBreaker({ destination: 'fake-crm', failureThreshold: 5, cooldownMs: 15_000, now: c.now, onChange: (ch) => changes.push(ch) });
    return { c, breaker, changes };
  };

  it('starts closed and lets deliveries through', () => {
    const { breaker } = make();
    expect(breaker.current).toBe('closed');
    expect(breaker.waitMs()).toBe(0);
  });

  it('opens after 5 failures in a row, and then makes everyone wait the cooldown', () => {
    const { breaker, changes, c } = make();
    for (let i = 0; i < 4; i++) breaker.failure('unreachable');
    expect(breaker.current).toBe('closed');
    breaker.failure('unreachable');
    expect(breaker.current).toBe('open');
    expect(changes).toEqual([expect.objectContaining({ from: 'closed', to: 'open', failures: 5, reason: '5 failures in a row, last: unreachable' })]);
    expect(breaker.waitMs()).toBe(15_000);
    c.advance(10_000);
    expect(breaker.waitMs()).toBe(5_000);
  });

  it('a success in between resets the count: it takes 5 failures IN A ROW', () => {
    const { breaker } = make();
    for (let i = 0; i < 4; i++) breaker.failure('500');
    breaker.success();
    for (let i = 0; i < 4; i++) breaker.failure('500');
    expect(breaker.current).toBe('closed');
  });

  it('after the cooldown, exactly one trial goes through (half-open); the others wait', () => {
    const { breaker, c } = make();
    for (let i = 0; i < 5; i++) breaker.failure('x');
    c.advance(15_000);
    expect(breaker.waitMs()).toBe(0); // the trial
    expect(breaker.current).toBe('half_open');
    expect(breaker.waitMs()).toBeGreaterThan(0); // a second loop must wait
    expect(breaker.waitMs()).toBeGreaterThan(0);
  });

  it('a trial that works closes it', () => {
    const { breaker, c, changes } = make();
    for (let i = 0; i < 5; i++) breaker.failure('x');
    c.advance(15_000);
    breaker.waitMs();
    breaker.success();
    expect(breaker.current).toBe('closed');
    expect(breaker.waitMs()).toBe(0);
    expect(changes.map((ch) => ch.to)).toEqual(['open', 'half_open', 'closed']);
  });

  it('a trial that fails opens it again for another full cooldown', () => {
    const { breaker, c } = make();
    for (let i = 0; i < 5; i++) breaker.failure('x');
    c.advance(15_000);
    breaker.waitMs();
    breaker.failure('still down');
    expect(breaker.current).toBe('open');
    expect(breaker.waitMs()).toBe(15_000);
  });

  it('if the trial loop finds no job, the trial slot is freed for the next loop', () => {
    const { breaker, c } = make();
    for (let i = 0; i < 5; i++) breaker.failure('x');
    c.advance(15_000);
    breaker.waitMs();
    breaker.nothingClaimed();
    expect(breaker.waitMs()).toBe(0);
  });
});

describe('Throttle', () => {
  /** A fake sleep that just moves the clock, so the test runs instantly. */
  const make = (perSecond: number, burst: number) => {
    const c = clock();
    const slept: number[] = [];
    const throttle = new Throttle({ perSecond, burst, now: c.now, sleep: async (ms) => { slept.push(ms); c.advance(ms); } });
    return { c, throttle, slept };
  };

  it('lets a burst through at once, then spaces calls at the rate', async () => {
    const { throttle, c } = make(5, 5);
    const start = c.now();
    for (let i = 0; i < 5; i++) expect(await throttle.acquire()).toBe(0);
    for (let i = 0; i < 5; i++) await throttle.acquire();
    // 5 more at 5/s take one second.
    expect(c.now() - start).toBe(1_000);
  });

  it('after a 429, every call waits for the Retry-After', async () => {
    const { throttle, c } = make(5, 5);
    const start = c.now();
    throttle.pauseFor(2_000);
    await throttle.acquire();
    expect(c.now() - start).toBeGreaterThanOrEqual(2_000);
  });

  it('a shorter pause does not cut a longer one', async () => {
    const { throttle, c } = make(5, 5);
    const start = c.now();
    throttle.pauseFor(3_000);
    throttle.pauseFor(1_000);
    await throttle.acquire();
    expect(c.now() - start).toBeGreaterThanOrEqual(3_000);
  });
});
