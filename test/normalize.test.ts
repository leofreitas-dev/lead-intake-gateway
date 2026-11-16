import { describe, expect, it } from 'vitest';
import { adapters, parseFrom } from '../src/leads/adapters.ts';
import { normalizeEmail, normalizeLead, normalizeName, normalizePhone } from '../src/leads/normalize.ts';

describe('normalizePhone → E.164', () => {
  it.each([
    ['(212) 555-0147', 'form'],
    ['212-555-0147', 'typed with dashes'],
    ['212.555.0147', 'typed with dots'],
    ['212 555 0147', 'typed with spaces'],
    ['2125550147', 'digits only'],
    ['12125550147', 'WhatsApp sender id'],
    ['1 (212) 555 0147', 'with the trunk prefix'],
    ['+1 212.555.0147', 'listing portal'],
    ['+1-212-555-0147', 'international with dashes'],
    ['+12125550147', 'already E.164'],
    ['  (212) 555-0147  ', 'surrounding spaces'],
    ['(212) 555-0147 ext. 12', 'with an extension'],
  ])('%s (%s) → +12125550147', (input) => {
    expect(normalizePhone(input)).toBe('+12125550147');
  });

  it('keeps a foreign number with its own country code', () => {
    expect(normalizePhone('+52 55 5555 0100')).toBe('+525555550100');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('refuses what is not a whole phone number instead of guessing', () => {
    for (const bad of ['555-0147', '123', 'call me', '', '+1 212 555 01470000']) {
      expect(normalizePhone(bad)).toBeNull();
    }
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Emily.Carter@Example.TEST ')).toBe('emily.carter@example.test');
  });

  it('does not remove dots or +tags (that could merge two different people)', () => {
    expect(normalizeEmail('emily.carter+homes@example.test')).toBe('emily.carter+homes@example.test');
    expect(normalizeEmail('emilycarter@example.test')).not.toBe(normalizeEmail('emily.carter@example.test'));
  });

  it('refuses what is not an address', () => {
    for (const bad of ['emily', 'emily@', '@example.test', 'emily carter@example.test', 'emily@example']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe('normalizeName', () => {
  it('collapses spaces and keeps capitalisation and accents', () => {
    expect(normalizeName('  Sofía   Ramírez ')).toBe('Sofía Ramírez');
    expect(normalizeName('Dan B')).toBe('Dan B');
    expect(normalizeName('   ')).toBeNull();
  });
});

describe('normalizeLead', () => {
  it('keeps the raw values and writes down what it could not use', () => {
    const lead = normalizeLead({ name: 'Marcus Lee', email: 'not-an-email', phone: '555-0182', occurredAt: 'yesterday' });
    expect(lead).toMatchObject({ name: 'Marcus Lee', email: null, phone: null, emailRaw: 'not-an-email', phoneRaw: '555-0182' });
    expect(lead.notes).toEqual([
      'email not recognised: "not-an-email"',
      'phone not recognised: "555-0182"',
      'date not recognised: "yesterday"',
    ]);
  });

  it('reads WhatsApp Unix-second timestamps and ISO dates', () => {
    expect(normalizeLead({ occurredAt: '1763305500' }).occurredAt?.toISOString()).toBe('2025-11-16T15:05:00.000Z');
    expect(normalizeLead({ occurredAt: '2026-11-16T10:02:00-05:00' }).occurredAt?.toISOString()).toBe('2026-11-16T15:02:00.000Z');
  });
});

describe('channel adapters', () => {
  it('form', () => {
    expect(adapters.form({ name: 'Emily Carter', email: 'e@example.test', phone: '(212) 555-0147', message: 'Hi', listing_id: 'JLR-1042', submitted_at: 'x' }))
      .toEqual({ name: 'Emily Carter', email: 'e@example.test', phone: '(212) 555-0147', message: 'Hi', listingRef: 'JLR-1042', occurredAt: 'x' });
  });

  it('whatsapp: the phone is the sender id', () => {
    expect(adapters.whatsapp({ from: '12125550147', profile_name: 'Emily C', text: 'Hi', timestamp: '1763305500' }))
      .toMatchObject({ name: 'Emily C', phone: '12125550147', message: 'Hi', occurredAt: '1763305500' });
  });

  it('portal: the lead is nested and the name comes in two parts', () => {
    expect(adapters.portal({ lead: { first_name: 'Emily', last_name: 'Carter', phone: '+1 212.555.0147' }, listing: { id: 'JLR-1042' } }))
      .toMatchObject({ name: 'Emily Carter', phone: '+1 212.555.0147', listingRef: 'JLR-1042' });
  });

  it('email: name and address come together in From', () => {
    expect(adapters.email({ from: 'Olivia Grant <olivia.grant@example.test>', subject: 'Photos', text: 'Hello' }))
      .toMatchObject({ name: 'Olivia Grant', email: 'olivia.grant@example.test', message: 'Photos\n\nHello' });
    expect(parseFrom('"Grant, Olivia" <olivia.grant@example.test>')).toEqual({ name: 'Grant, Olivia', email: 'olivia.grant@example.test' });
    expect(parseFrom('olivia.grant@example.test')).toEqual({ email: 'olivia.grant@example.test' });
  });

  it('ignores fields of the wrong type instead of failing', () => {
    expect(adapters.form({ name: 42, email: ['a'], phone: null })).toEqual({ name: '42' });
    expect(adapters.portal({ lead: 'oops' })).toEqual({});
  });
});
