import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { RawLead } from './adapters.ts';

/** The agency is in the US: a number written without a country code is a US number. */
export const DEFAULT_COUNTRY: CountryCode = 'US';

export interface NormalizedLead {
  name: string | null;
  /** Trimmed and lower case. */
  email: string | null;
  /** E.164: + country code + number, digits only. */
  phone: string | null;
  emailRaw: string | null;
  phoneRaw: string | null;
  message: string | null;
  listingRef: string | null;
  occurredAt: Date | null;
  /** What could not be used, and why. Shown to a human later; never silently dropped. */
  notes: string[];
}

export function normalizeLead(raw: RawLead): NormalizedLead {
  const notes: string[] = [];
  const email = normalizeEmail(raw.email);
  if (raw.email && !email) notes.push(`email not recognised: "${raw.email}"`);
  const phone = normalizePhone(raw.phone);
  if (raw.phone && !phone) notes.push(`phone not recognised: "${raw.phone}"`);
  const occurredAt = parseDate(raw.occurredAt);
  if (raw.occurredAt && !occurredAt) notes.push(`date not recognised: "${raw.occurredAt}"`);
  return {
    name: normalizeName(raw.name),
    email,
    phone,
    emailRaw: raw.email ?? null,
    phoneRaw: raw.phone ?? null,
    message: raw.message?.trim() || null,
    listingRef: raw.listingRef?.trim() || null,
    occurredAt,
    notes,
  };
}

/**
 * Trim and lower-case. Nothing more: removing dots or "+tags" is right for some
 * providers and wrong for others, and a wrong guess would merge two people.
 */
export function normalizeEmail(value: string | undefined): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z0-9-]{2,}$/.test(email) ? email : null;
}

/**
 * Any common way of writing a phone → E.164.
 * "(212) 555-0147", "212.555.0147", "12125550147" and "+1 212 555 0147"
 * all become "+12125550147". Extensions are dropped (they reach the same line).
 * A number with the wrong length for its country is refused rather than guessed.
 */
export function normalizePhone(value: string | undefined, country: CountryCode = DEFAULT_COUNTRY): string | null {
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, country);
  return parsed && parsed.isPossible() ? parsed.number : null;
}

/** Collapse spaces; keep the person's own capitalisation and accents ("Sofía Ramírez"). */
export function normalizeName(value: string | undefined): string | null {
  if (!value) return null;
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return name || null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  // WhatsApp sends Unix seconds as a string.
  const date = /^\d{9,10}$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
