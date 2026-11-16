import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/gateway/rate-limiter.ts';

describe('rate limiter (token bucket)', () => {
  const setup = () => {
    let now = 0;
    const limiter = new RateLimiter({ perSecond: 2, burst: 3, now: () => now });
    return { limiter, advance: (ms: number) => (now += ms) };
  };

  it('lets a burst through, then refuses with a retry time', () => {
    const { limiter } = setup();
    expect([1, 2, 3].map(() => limiter.take('form|1.2.3.4').allowed)).toEqual([true, true, true]);
    expect(limiter.take('form|1.2.3.4')).toEqual({ allowed: false, retryAfterSec: 1 });
  });

  it('refills over time at the per-second rate', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i++) limiter.take('k');
    expect(limiter.take('k').allowed).toBe(false);
    advance(500); // 2 per second → one token after half a second
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);
  });

  it('never stores more than the burst, however long it waits', () => {
    const { limiter, advance } = setup();
    advance(60_000);
    expect([1, 2, 3, 4].map(() => limiter.take('k').allowed)).toEqual([true, true, true, false]);
  });

  it('keeps a separate bucket per key', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.take('form|1.1.1.1');
    expect(limiter.take('form|1.1.1.1').allowed).toBe(false);
    expect(limiter.take('form|2.2.2.2').allowed).toBe(true);
    expect(limiter.take('whatsapp|1.1.1.1').allowed).toBe(true);
  });
});
