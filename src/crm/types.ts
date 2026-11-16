/**
 * What the gateway sends to a CRM: one contact, as it is now. Every delivery
 * sends the whole picture (not a change), so delivering twice, or out of order
 * after a retry, ends in the same record.
 */
export interface CrmContact {
  /** Stable id from our side. The CRM upserts by it: the same id never makes a second record. */
  externalId: string;
  name: string | null;
  emails: string[];
  phones: string[];
  /** Where the latest lead was routed (who owns the contact) and why. */
  owner: string;
  ownerReason: string;
  intent: string | null;
  urgency: string | null;
  budgetBand: string | null;
  language: string | null;
  leadCount: number;
  sources: string[];
  lastLeadAt: string;
  /** External ids of contacts found to be this same person; the CRM folds them into this one. */
  mergedExternalIds: string[];
}

export interface UpsertResult {
  crmId: string;
  created: boolean;
}

/**
 * Any CRM the gateway can deliver to. The fake CRM (HTTP) is one implementation;
 * HubSpot will be another. The delivery worker only knows this interface.
 */
export interface CrmClient {
  /** Name of the destination, e.g. "fake-crm". The circuit breaker is per destination. */
  readonly name: string;
  /** Creates or updates the contact with this externalId. Throws CrmError on failure. */
  upsertContact(contact: CrmContact, ctx: { traceId: string | null }): Promise<UpsertResult>;
}

export type CrmErrorKind = 'unreachable' | 'timeout' | 'rate_limited' | 'server_error' | 'rejected';

/**
 * A failed CRM call, already sorted into what the worker needs to know:
 * - retryable: will trying again later possibly work? (a refused payload will not)
 * - countsAgainstDestination: does it say the CRM is unwell? (feeds the circuit breaker;
 *   a 429 means "slow down", not "down", and a 4xx is about our data)
 * - retryAfterMs: how long the CRM asked us to wait.
 */
export class CrmError extends Error {
  readonly kind: CrmErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly countsAgainstDestination: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(kind: CrmErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'CrmError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = kind !== 'rejected';
    this.countsAgainstDestination = kind === 'unreachable' || kind === 'timeout' || kind === 'server_error';
  }
}

/** Our stable id for a contact in any CRM. */
export function externalIdFor(contactId: string): string {
  return `lig_contact_${contactId.replaceAll('-', '')}`;
}
