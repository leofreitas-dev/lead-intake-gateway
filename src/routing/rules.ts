import type { ClassifyResult } from '../ai/classify.ts';
import type { Classification } from '../ai/schema.ts';

/** Where a lead goes at Juniper Lane Realty. */
export const ROUTES = {
  manual_review: 'Manual review',
  archive: 'Archive',
  general_inbox: 'General inbox',
  spanish_agent: 'Spanish-speaking agent',
  on_call_agent: 'On-call agent (call within 15 min)',
  buyer_team: 'Buyer team',
  listing_team: 'Listing team (sellers)',
  rentals_desk: 'Rentals desk',
} as const;
export type Route = keyof typeof ROUTES;

export interface RouteDecision {
  route: Route;
  /** The name of the rule that matched, for logs and tests. */
  rule: string;
  /** Plain-English reason, shown to the team. */
  reason: string;
}

interface Rule {
  name: string;
  when: (c: Classification) => boolean;
  route: Route;
  why: (c: Classification) => string;
}

/** Languages someone at the agency speaks. A lead in another language needs a person to find help. */
export const AGENT_LANGUAGES: Record<string, Route> = { es: 'spanish_agent' };

/**
 * The routing rules, checked top to bottom; the first that matches wins.
 * The AI never picks the route: it only describes the lead, and these lines
 * of code decide. Changing who gets what is a code change, reviewed and tested.
 */
export const RULES: Rule[] = [
  { name: 'spam', when: (c) => c.intent === 'spam', route: 'archive', why: () => 'spam: archived, nobody is notified' },
  { name: 'vendor', when: (c) => c.intent === 'vendor', route: 'general_inbox', why: () => 'a business offering services, not a client: goes to the general inbox' },
  {
    name: 'language-with-agent',
    when: (c) => c.language !== 'en' && c.language in AGENT_LANGUAGES,
    route: 'spanish_agent',
    why: (c) => `written in ${languageName(c.language)}: goes to an agent who speaks it`,
  },
  {
    name: 'language-without-agent',
    when: (c) => c.language !== 'en',
    route: 'manual_review',
    why: (c) => `written in ${languageName(c.language)} and no agent speaks it: a person decides`,
  },
  {
    name: 'urgent-buyer-or-seller',
    when: (c) => (c.intent === 'buy' || c.intent === 'sell') && c.urgency === 'high',
    route: 'on_call_agent',
    why: (c) => `wants to ${c.intent} and urgency is high: the on-call agent calls back within 15 minutes`,
  },
  { name: 'buyer', when: (c) => c.intent === 'buy', route: 'buyer_team', why: (c) => `wants to buy, urgency ${c.urgency}` },
  { name: 'seller', when: (c) => c.intent === 'sell', route: 'listing_team', why: (c) => `wants to sell or value a home, urgency ${c.urgency}` },
  { name: 'renter', when: (c) => c.intent === 'rent', route: 'rentals_desk', why: (c) => `wants to rent, urgency ${c.urgency}` },
  { name: 'other', when: () => true, route: 'general_inbox', why: () => 'not a buyer, seller or renter: goes to the general inbox' },
];

/** Decides the route for a classified lead. A lead the AI could not classify surely goes to a person. */
export function decideRoute(result: Pick<ClassifyResult, 'status' | 'classification' | 'reviewReason'>): RouteDecision {
  if (result.status === 'needs_review' || !result.classification) {
    return { route: 'manual_review', rule: 'needs-review', reason: result.reviewReason ?? 'the AI gave no usable answer' };
  }
  const c = result.classification;
  const rule = RULES.find((r) => r.when(c))!; // the last rule always matches
  const route = rule.name === 'language-with-agent' ? AGENT_LANGUAGES[c.language] : rule.route;
  return { route, rule: rule.name, reason: rule.why(c) };
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
