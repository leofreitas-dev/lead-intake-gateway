import { describe, expect, it } from 'vitest';
import { machine, percentile } from '../src/cli/support.ts';

describe('percentile (used by npm run bench)', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  it('is the nearest rank: p95 of 1..100 is 95, p50 is 50, p100 is the slowest', () => {
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it('rounds up on small lists, so it never claims a value faster than measured', () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20, 30], 95)).toBe(30);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([10, 20], 0)).toBe(10);
  });

  it('is NaN with nothing measured, instead of a made-up 0', () => {
    expect(percentile([], 95)).toBeNaN();
  });
});

describe('machine (written in every bench report)', () => {
  it('names the CPU, cores, memory, OS and Node version', () => {
    const m = machine();
    expect(m.cpus).toBeGreaterThan(0);
    expect(m.memory_gb).toBeGreaterThan(0);
    expect(m.node).toBe(process.version);
    expect(m.cpu).not.toBe('');
  });
});
