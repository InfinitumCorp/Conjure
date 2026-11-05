// Per-million-token list prices (USD) for cost estimates. First-party Claude API
// rates; check current pricing before relying on these for billing.
// Cache writes (5-minute TTL) are billed at 1.25x the input rate.
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

export function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

export function addUsage(total, u) {
  if (!u) return total;
  for (const k of Object.keys(total)) total[k] += Number(u[k]) || 0;
  return total;
}

/** Returns an estimated cost in USD, or null when the model has no known price. */
export function estimateCost(model, usage) {
  const p = PRICES[model];
  if (!p) return null;
  const usd =
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_read_input_tokens * p.cacheRead +
      usage.cache_creation_input_tokens * p.input * 1.25) /
    1e6;
  return Math.round(usd * 10000) / 10000;
}
