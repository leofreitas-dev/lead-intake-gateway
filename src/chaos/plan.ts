// The chaos run's traffic, decided up front from a seed: who writes, through
// which channel, which webhooks are sent twice, and therefore what the CRM must
// hold at the end. The expectations come from this plan, never from the system
// under test.
import { loadFixture } from '../fixtures.ts';
import type { Source } from '../sources.ts';

/**
 * The demo leads are the templates: their messages have real recorded AI
 * answers, so the chaos run classifies for free. Only who wrote changes.
 */
export const TEMPLATES: { source: Source; fixture: string; spam?: true }[] = [
  { source: 'form', fixture: 'lead-01' },
  { source: 'form', fixture: 'lead-08' },
  { source: 'form', fixture: 'lead-11' },
  { source: 'email', fixture: 'lead-06' },
  { source: 'whatsapp', fixture: 'lead-02' },
  { source: 'whatsapp', fixture: 'lead-04' },
  { source: 'whatsapp', fixture: 'lead-09' },
  { source: 'portal', fixture: 'lead-03' },
  { source: 'portal', fixture: 'lead-07' },
  { source: 'portal', fixture: 'lead-10' },
];
/** The SEO spam: routed to the archive, so it must never reach the CRM. */
export const SPAM_TEMPLATE = { source: 'form' as Source, fixture: 'lead-05', spam: true as const };

const FIRST = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Rowan', 'Skyler', 'Emerson', 'Finley', 'Harper', 'Reese'];
const LAST = ['Hale', 'Lin', 'Okafor', 'Novak', 'Reyes', 'Brandt', 'Moreau', 'Sato', 'Kowal', 'Ibarra'];
/** Fictional phones only: 555-0100 to 555-0199, in US area codes. */
const AREAS = ['212', '646', '917', '718', '347', '305', '786', '415', '312', '617'];

export interface Person { index: number; name: string; first: string; email: string; phoneE164: string }

export interface PlannedWebhook {
  /** Position in the plan; the same for a webhook and its resends. */
  n: number;
  source: Source;
  fixture: string;
  body: string;
  /** Sent as X-Event-Id, like providers that have one. Undefined: the gateway hashes the body. */
  eventId?: string;
  /** The person and the identifiers this lead carries, as the gateway will normalise them. */
  person: number;
  keys: string[];
  spam: boolean;
  /** A copy of webhook `n`, sent again on purpose (provider retry). */
  resendOf?: number;
}

export interface Plan {
  seed: number;
  people: Person[];
  /** Every request to send, originals and resends, in send order. */
  sends: PlannedWebhook[];
  /** The unique leads (one per original). */
  leads: PlannedWebhook[];
  /** Groups of identifiers linked by some lead: each must end as exactly one contact. */
  groups: ExpectedGroup[];
  groupOfKey: Map<string, number>;
}

export interface ExpectedGroup {
  id: number;
  keys: string[];
  leadCount: number;
  /** At least one lead that is not spam: it must be in the CRM, exactly once. */
  delivered: boolean;
}

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePlan({ seed = 1, people: count = 120, spammers = 8, resendRate = 0.15 } = {}): Plan {
  const random = rng(seed);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  if (count + spammers > AREAS.length * 100) throw new Error('not enough fictional phone numbers');

  const people: Person[] = Array.from({ length: count + spammers }, (_, i) => {
    const first = pick(FIRST);
    const last = pick(LAST);
    const area = AREAS[Math.floor(i / 100)];
    const line = String(i % 100).padStart(2, '0');
    return { index: i, first, name: `${first} ${last}`, email: `${first}.${last}.${i}@chaos.example.test`.toLowerCase(), phoneE164: `+1${area}55501${line}` };
  });

  const originals: PlannedWebhook[] = [];
  const base = Date.UTC(2026, 10, 16, 14, 0, 0);
  const add = (person: Person, template: { source: Source; fixture: string; spam?: true }) => {
    const n = originals.length;
    const at = new Date(base + n * 1000);
    const body = JSON.parse(loadFixture(template.source, template.fixture).body);
    const area = person.phoneE164.slice(2, 5);
    const local = person.phoneE164.slice(5);
    const phoneRaw = `(${area}) ${local.slice(0, 3)}-${local.slice(3)}`;
    const keys: string[] = [];
    switch (template.source) {
      case 'form': {
        body.name = template.spam ? 'Growth Hacker Agency' : person.name;
        body.email = person.email;
        const withPhone = !template.spam && random() < 0.7;
        body.phone = withPhone ? phoneRaw : '';
        body.submitted_at = at.toISOString();
        keys.push(`e:${person.email}`);
        if (withPhone) keys.push(`p:${person.phoneE164}`);
        break;
      }
      case 'email':
        body.from = `${person.name} <${person.email}>`;
        body.date = at.toUTCString();
        body.message_id = `<chaos-${seed}-${n}@chaos.example.test>`;
        keys.push(`e:${person.email}`);
        break;
      case 'whatsapp':
        body.from = person.phoneE164.slice(1);
        body.profile_name = person.first;
        body.timestamp = String(Math.floor(at.getTime() / 1000));
        body.message_id = `wamid.chaos.${seed}.${n}`;
        keys.push(`p:${person.phoneE164}`);
        break;
      case 'portal':
        body.lead.first_name = person.first;
        body.lead.last_name = person.name.split(' ')[1];
        body.lead.email = person.email;
        body.lead.phone = phoneRaw;
        body.created_at = at.toISOString();
        keys.push(`e:${person.email}`, `p:${person.phoneE164}`);
        break;
    }
    originals.push({
      n,
      source: template.source,
      fixture: template.fixture,
      body: JSON.stringify(body),
      eventId: random() < 0.5 ? `evt-chaos-${seed}-${n}` : undefined,
      person: person.index,
      keys,
      spam: template.spam === true,
    });
  };

  for (const person of people.slice(0, count)) {
    const leads = 1 + Math.floor(random() * 4); // 1 to 4 leads each
    for (let k = 0; k < leads; k++) add(person, pick(TEMPLATES));
  }
  for (const person of people.slice(count)) add(person, SPAM_TEMPLATE);

  // Shuffle the arrival order, then add the resends: some right behind the
  // original (racing it), some later in the burst.
  for (let i = originals.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [originals[i], originals[j]] = [originals[j], originals[i]];
  }
  const sends: PlannedWebhook[] = [...originals];
  for (const original of originals) {
    if (random() >= resendRate) continue;
    const copy = { ...original, resendOf: original.n };
    const at = sends.indexOf(original) + (random() < 0.5 ? 1 : 1 + Math.floor(random() * 60));
    sends.splice(Math.min(at, sends.length), 0, copy);
  }

  // Expected contacts: identifiers linked by a lead are one person (union-find).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    const p = parent.get(k)!;
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  for (const lead of originals) for (const k of lead.keys.slice(1)) parent.set(find(k), find(lead.keys[0]));
  const byRoot = new Map<string, ExpectedGroup>();
  const groupOfKey = new Map<string, number>();
  for (const lead of originals) {
    const root = find(lead.keys[0]);
    let group = byRoot.get(root);
    if (!group) {
      group = { id: byRoot.size, keys: [], leadCount: 0, delivered: false };
      byRoot.set(root, group);
    }
    group.leadCount++;
    if (!lead.spam) group.delivered = true;
    for (const k of lead.keys) {
      if (!groupOfKey.has(k)) {
        groupOfKey.set(k, group.id);
        group.keys.push(k);
      }
    }
  }

  return { seed, people, sends, leads: originals, groups: [...byRoot.values()], groupOfKey };
}
