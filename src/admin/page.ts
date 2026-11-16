import fs from 'node:fs';
import { DEMO_ADMIN_TOKEN } from '../config.ts';

const TEMPLATE = fs.readFileSync(new URL('./console.html', import.meta.url), 'utf8');

/**
 * The approval screen: one HTML file with its CSS and JS inline, so it works
 * with no internet (no CDN, no fonts, no external requests). It holds no data;
 * everything comes from the /api routes, which need the admin token.
 */
export function consolePage(usingDemoToken: boolean): string {
  // With the published demo token, the page offers it (and says it is for the demo only).
  return TEMPLATE.replace('"__DEMO_TOKEN__"', usingDemoToken ? JSON.stringify(DEMO_ADMIN_TOKEN) : 'null');
}
