import { describe, expect, it } from 'vitest';
import { computeSignature, signatureHeader, verifySignature } from '../src/gateway/signature.ts';

const SECRET = 'test-secret-form-0123456789';
const BODY = '{"name":"Emily Carter","email":"emily.carter@example.test"}';
const NOW = 1_763_290_000;

const check = (header: string | undefined, overrides: { body?: string; secret?: string; nowSec?: number } = {}) =>
  verifySignature({
    header,
    rawBody: overrides.body ?? BODY,
    secret: overrides.secret ?? SECRET,
    toleranceSec: 300,
    nowSec: overrides.nowSec ?? NOW,
  });

describe('webhook signature', () => {
  it('accepts a body signed with the right secret', () => {
    expect(check(signatureHeader(SECRET, BODY, NOW))).toEqual({ ok: true });
  });

  it('refuses a missing header', () => {
    expect(check(undefined)).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('refuses a header without a time or a signature', () => {
    expect(check('v1=abc')).toEqual({ ok: false, reason: 'signature_malformed' });
    expect(check(`t=${NOW}`)).toEqual({ ok: false, reason: 'signature_malformed' });
    expect(check('nonsense')).toEqual({ ok: false, reason: 'signature_malformed' });
  });

  it('refuses a signature made with another secret', () => {
    expect(check(signatureHeader('some-other-secret-000000', BODY, NOW))).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('refuses a body changed after signing, even by one character', () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(check(header, { body: BODY.replace('Emily', 'EmilY') })).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('refuses a signature whose time was edited (the time is signed too)', () => {
    const real = computeSignature(SECRET, NOW - 3600, BODY);
    expect(check(`t=${NOW},v1=${real}`)).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('accepts up to 5 minutes of clock difference, in both directions', () => {
    expect(check(signatureHeader(SECRET, BODY, NOW - 300))).toEqual({ ok: true });
    expect(check(signatureHeader(SECRET, BODY, NOW + 300))).toEqual({ ok: true });
  });

  it('refuses a request signed more than 5 minutes ago or ahead (replay)', () => {
    expect(check(signatureHeader(SECRET, BODY, NOW - 301))).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(check(signatureHeader(SECRET, BODY, NOW + 301))).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('accepts any one of several signatures (secret rotation)', () => {
    const oldOne = computeSignature('the-old-secret-0000000000', NOW, BODY);
    const newOne = computeSignature(SECRET, NOW, BODY);
    expect(check(`t=${NOW},v1=${oldOne},v1=${newOne}`)).toEqual({ ok: true });
  });
});
