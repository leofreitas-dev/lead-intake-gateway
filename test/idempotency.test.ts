import { describe, expect, it } from 'vitest';
import { idempotencyKey } from '../src/gateway/idempotency.ts';

const BODY = '{"name":"Emily Carter"}';

describe('idempotency key', () => {
  it('uses the Idempotency-Key header first', () => {
    expect(idempotencyKey({ 'idempotency-key': 'abc-1', 'x-event-id': 'evt_9' }, BODY)).toEqual({
      key: 'key:abc-1',
      from: 'idempotency-key',
    });
  });

  it('then the provider event id', () => {
    expect(idempotencyKey({ 'x-event-id': 'evt_9' }, BODY)).toEqual({ key: 'event:evt_9', from: 'x-event-id' });
  });

  it('otherwise a hash of the body: same bytes, same key', () => {
    const a = idempotencyKey({}, BODY);
    expect(a.from).toBe('body-hash');
    expect(a.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(idempotencyKey({}, BODY)).toEqual(a);
  });

  it('gives a different key to a different body', () => {
    expect(idempotencyKey({}, '{"name":"Emily Carter "}').key).not.toBe(idempotencyKey({}, BODY).key);
  });

  it('ignores an empty or oversized header and falls back to the hash', () => {
    expect(idempotencyKey({ 'idempotency-key': '  ' }, BODY).from).toBe('body-hash');
    expect(idempotencyKey({ 'idempotency-key': 'x'.repeat(201) }, BODY).from).toBe('body-hash');
  });
});
