import type { Source } from '../sources.ts';

/** The fields we care about, as each channel sent them (not cleaned up yet). */
export interface RawLead {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  listingRef?: string;
  /** When the person wrote, according to the channel. */
  occurredAt?: string;
}

type Json = Record<string, unknown>;

/**
 * Every channel names its fields differently. An adapter maps one channel's
 * payload to RawLead. Unknown or missing fields simply stay undefined.
 */
export const adapters: Record<Source, (body: Json) => RawLead> = {
  // Website contact form.
  form: (b) => ({
    name: str(b.name) ?? join(str(b.first_name), str(b.last_name)),
    email: str(b.email),
    phone: str(b.phone),
    message: str(b.message),
    listingRef: str(b.listing_id),
    occurredAt: str(b.submitted_at),
  }),

  // Inbound email, as an email provider's webhook delivers it: "From" holds
  // both the name and the address, e.g. "Olivia Grant <olivia@example.test>".
  email: (b) => {
    const from = parseFrom(str(b.from));
    return {
      name: from.name,
      email: from.email,
      message: join(str(b.subject), str(b.text), '\n\n'),
      occurredAt: str(b.date),
    };
  },

  // WhatsApp Business: the phone is the sender id, the name is the profile name.
  whatsapp: (b) => ({
    name: str(b.profile_name),
    phone: str(b.from),
    message: str(b.text),
    occurredAt: str(b.timestamp),
  }),

  // Listing portal: the lead is nested, the listing has its own block.
  portal: (b) => {
    const lead = obj(b.lead);
    return {
      name: join(str(lead.first_name), str(lead.last_name)) ?? str(lead.name),
      email: str(lead.email),
      phone: str(lead.phone),
      message: str(lead.comments),
      listingRef: str(obj(b.listing).id),
      occurredAt: str(b.created_at),
    };
  },
};

function str(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function join(a: string | undefined, b: string | undefined, sep = ' '): string | undefined {
  const parts = [a, b].filter((p): p is string => p !== undefined).map((p) => p.trim());
  return parts.length ? parts.join(sep) : undefined;
}

/** "Olivia Grant <olivia@example.test>" → { name, email }. A bare address works too. */
export function parseFrom(from: string | undefined): { name?: string; email?: string } {
  if (!from) return {};
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim() || undefined, email: match[2].trim() };
  return { email: from.trim() };
}
