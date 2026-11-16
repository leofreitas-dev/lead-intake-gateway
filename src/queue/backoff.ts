/**
 * How long to wait before retry number `attempt` (1, 2, 3...): exponential
 * (1 s, 2 s, 4 s...) up to `maxMs`, with "full jitter": a random time between
 * zero and that value. Without jitter, every job that failed during an outage
 * would retry at the same instant when the dependency comes back.
 */
export function backoffMs(attempt: number, opts: { baseMs?: number; maxMs?: number; random?: () => number } = {}): number {
  const { baseMs = 1_000, maxMs = 10 * 60_000, random = Math.random } = opts;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}
