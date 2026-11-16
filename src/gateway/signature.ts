import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures, in the same shape Stripe uses:
 *
 *   X-Signature: t=1763290920,v1=5f2b...e9
 *
 * `t` is the Unix time the sender signed at. `v1` is
 * HMAC-SHA256(secret, `${t}.${rawBody}`) in hex. Signing the time together with
 * the body means an attacker cannot reuse an old signature with a new time.
 * Several `v1` values are allowed, so a secret can be rotated without downtime.
 */
export const SIGNATURE_HEADER = 'x-signature';

export type SignatureFailure = 'signature_missing' | 'signature_malformed' | 'timestamp_out_of_tolerance' | 'signature_invalid';

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

export function computeSignature(secret: string, timestampSec: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
}

/** Builds the header value a sender would put on the request. */
export function signatureHeader(secret: string, rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSec},v1=${computeSignature(secret, timestampSec, rawBody)}`;
}

export function verifySignature(input: {
  header: string | undefined;
  rawBody: string;
  secret: string;
  toleranceSec: number;
  nowSec?: number;
}): SignatureCheck {
  const { header, rawBody, secret, toleranceSec } = input;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (!header) return { ok: false, reason: 'signature_missing' };

  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && /^\d{1,12}$/.test(value ?? '')) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value ?? '')) candidates.push(value);
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: 'signature_malformed' };

  // Checked before the HMAC: a stale request is refused even if it was genuine once.
  if (Math.abs(nowSec - timestamp) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex');
  // timingSafeEqual takes the same time whether the first or the last byte differs,
  // so an attacker cannot guess the signature byte by byte from response times.
  const match = candidates.some((c) => timingSafeEqual(Buffer.from(c, 'hex'), expected));
  return match ? { ok: true } : { ok: false, reason: 'signature_invalid' };
}
