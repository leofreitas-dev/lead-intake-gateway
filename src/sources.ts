/** The channels a lead can arrive from. Each one gets its own webhook URL and secret. */
export const SOURCES = ['form', 'email', 'whatsapp', 'portal'] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}
