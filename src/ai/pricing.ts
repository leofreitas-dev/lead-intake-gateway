import fs from 'node:fs';
import path from 'node:path';

export interface ModelPrice {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

export interface PriceList {
  source: string;
  checkedOn: string;
  models: Record<string, ModelPrice>;
}

export const PRICING_FILE = path.resolve(import.meta.dirname, '../../config/pricing.json');

/** Reads config/pricing.json: the price per token, with where and when it was checked. */
export function loadPriceList(file = PRICING_FILE): PriceList {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { source: raw._source, checkedOn: raw._checked_on, models: raw.models };
}

/** Cost in US dollars of one call. Throws for a model with no price, so a cost is never silently 0. */
export function costUsd(prices: PriceList, model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const price = prices.models[model];
  if (!price) throw new Error(`no price for model "${model}" in config/pricing.json`);
  return (usage.inputTokens * price.input_usd_per_mtok + usage.outputTokens * price.output_usd_per_mtok) / 1_000_000;
}
