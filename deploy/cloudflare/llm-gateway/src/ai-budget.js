// Shared Workers AI budget for every Worker on the Infinitum Cloudflare account.
//
// Workers AI gives the account 10,000 neurons a day at no charge; past that it bills.
// The conjure-llm Worker owns one ledger (its `Budget` Durable Object). Each Worker that
// uses Workers AI binds to that Durable Object and wraps its AI binding with budgetedAI(),
// so every call on the account reserves its worst-case cost first, settles to real usage
// after, and is refused once the day's free allowance would be exceeded.
//
// Copy this file unchanged into a Worker, then:
//   wrangler.jsonc: "durable_objects": { "bindings": [{ "name": "AI_BUDGET", "class_name": "Budget", "script_name": "conjure-llm" }] }
//   code:           const ai = budgetedAI(env.AI, env.AI_BUDGET);

/** Daily neuron ceiling for the whole account (10,000 free, minus a margin). */
export const DAILY_NEURONS = 9500;

/** Neurons per million tokens [input, output], from the Workers AI pricing page. */
export const RATES = {
  "@cf/qwen/qwen3-30b-a3b-fp8": [4625, 30475],
  "@cf/meta/llama-3.2-3b-instruct": [4625, 30475],
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": [4119, 34868],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [26668, 204805],
  "@cf/openai/gpt-oss-20b": [18182, 27273],
  "@cf/openai/gpt-oss-120b": [31818, 68182],
};
/** Models not listed are charged at the most expensive listed rate, so the cap stays safe. */
const FALLBACK = [31818, 204805];
/** Image generation is priced per tile and step; a flat upper bound per call. */
const IMAGE_NEURONS = 100;

export const neuronsFor = (model, inputTokens, outputTokens) => {
  const [i, o] = RATES[model] ?? FALLBACK;
  return (inputTokens * i + outputTokens * o) / 1_000_000;
};

const isImageModel = (model, input) => /flux|stable-diffusion|dreamshaper|lucid|phoenix|image/i.test(model) || (input && "prompt" in input && !("messages" in input));

/** Upper bound for one call: every input character a token (real text runs ~4 per token), plus a full reply. */
export function worstCase(model, input = {}) {
  if (isImageModel(model, input)) return IMAGE_NEURONS;
  const inChars = JSON.stringify(input.messages ?? input.prompt ?? "").length + JSON.stringify(input.tools ?? []).length;
  return neuronsFor(model, inChars, Math.min(Number(input.max_tokens) || 2000, 8192));
}

/** Real usage when Workers AI reports it; otherwise null (the reservation stands). */
export function actualNeurons(model, result) {
  const u = result?.usage;
  if (!u || typeof u !== "object") return null;
  if (typeof u.neurons === "number") return u.neurons;
  if (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number") return neuronsFor(model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0);
  return null;
}

export class FreeAllowanceUsed extends Error {
  constructor() {
    super("The free daily AI allowance is used up. It resets at 00:00 UTC.");
    this.name = "FreeAllowanceUsed";
    this.status = 429;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Wrap a Workers AI binding so every run() is charged to the shared daily ledger.
 * Without a ledger binding it returns the AI binding unchanged.
 */
export function budgetedAI(ai, ledgerNamespace, { limit = DAILY_NEURONS, waitUntil } = {}) {
  if (!ai || !ledgerNamespace) return ai;
  const ledger = () => ledgerNamespace.get(ledgerNamespace.idFromName("daily"));
  return new Proxy(ai, {
    get(target, prop) {
      if (prop !== "run") {
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (model, input, options) => {
        const reserved = worstCase(model, input);
        const day = today();
        const hold = await ledger().reserve(limit, reserved);
        if (!hold.ok) throw new FreeAllowanceUsed();
        let actual = reserved;
        try {
          const result = await target.run(model, input, options);
          // Streams and images keep their reservation (an over-count, never an under-count).
          if (!(result instanceof ReadableStream)) actual = actualNeurons(model, result) ?? reserved;
          return result;
        } catch (err) {
          actual = 0; // a failed call is not billed
          throw err;
        } finally {
          const settle = ledger().settle(day, reserved, actual);
          if (waitUntil) waitUntil(settle);
          else await settle;
        }
      };
    },
  });
}
