import { type CrmClient, type CrmContact, CrmError, type UpsertResult } from './types.ts';

/**
 * Talks to a CRM with a simple REST API: PUT /contacts/{externalId} creates or
 * updates the contact (an upsert). This is the API of the fake CRM
 * (src/fake-crm); a real CRM gets its own class with the same interface.
 */
export class HttpCrmClient implements CrmClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; timeoutMs?: number; name?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.name = opts.name ?? 'fake-crm';
  }

  async upsertContact(contact: CrmContact, ctx: { traceId: string | null }): Promise<UpsertResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/contacts/${encodeURIComponent(contact.externalId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(ctx.traceId ? { 'x-request-id': ctx.traceId } : {}) },
        body: JSON.stringify(contact),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (e.name === 'TimeoutError') {
        // The CRM may still have saved it: the upsert makes the retry harmless.
        throw new CrmError('timeout', `no answer from the CRM within ${this.timeoutMs} ms`);
      }
      throw new CrmError('unreachable', `CRM unreachable (${e.cause?.code ?? e.message})`);
    }

    if (res.ok) {
      const body = (await res.json()) as { id: string; created: boolean };
      return { crmId: body.id, created: body.created };
    }
    const text = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      throw new CrmError('rate_limited', 'CRM said 429 Too Many Requests', {
        status: 429,
        retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 1_000,
      });
    }
    if (res.status >= 500) throw new CrmError('server_error', `CRM error ${res.status}${text ? `: ${text}` : ''}`, { status: res.status });
    throw new CrmError('rejected', `CRM refused the contact (${res.status})${text ? `: ${text}` : ''}`, { status: res.status });
  }
}
