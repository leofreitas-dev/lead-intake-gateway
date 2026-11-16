import { createHash } from 'node:crypto';

export interface IdempotencyKey {
  key: string;
  /** Where the key came from, stored for debugging. */
  from: 'idempotency-key' | 'x-event-id' | 'body-hash';
}

const MAX_KEY_LENGTH = 200;

/**
 * The fingerprint that tells a resent webhook apart from a new one.
 * 1. The sender's `Idempotency-Key` header, if it sends one.
 * 2. The provider's event id (`X-Event-Id`), if it sends one.
 * 3. Otherwise a SHA-256 of the raw body: the exact same bytes are the same webhook.
 *    (The source is part of the inbox's unique key, so it is not hashed in here.)
 */
export function idempotencyKey(headers: Record<string, string | string[] | undefined>, rawBody: string): IdempotencyKey {
  const fromHeader = (name: string) => {
    const value = headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    return text && text.trim() && text.length <= MAX_KEY_LENGTH ? text.trim() : undefined;
  };
  const explicit = fromHeader('idempotency-key');
  if (explicit) return { key: `key:${explicit}`, from: 'idempotency-key' };
  const eventId = fromHeader('x-event-id');
  if (eventId) return { key: `event:${eventId}`, from: 'x-event-id' };
  return { key: `sha256:${createHash('sha256').update(rawBody).digest('hex')}`, from: 'body-hash' };
}
