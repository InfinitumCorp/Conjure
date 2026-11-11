// Free fallback providers for the Conjure model gateway.
//
// Workers AI runs first while its free daily allowance lasts. After that, or when it errors,
// the gateway tries each provider below in order. Every one serves open-weight models on a
// free plan that does not bill: a provider is only used when its API key is stored as a
// Worker secret, and a rate-limit or server error moves on to the next one.

/** Order matters: the first configured provider that answers wins. */
export const PROVIDERS = [
  {
    name: "groq",
    // Free plan: 1,000 requests and 200,000 tokens a day per model.
    baseUrl: "https://api.groq.com/openai/v1",
    keyVar: "GROQ_API_KEY",
    modelVar: "GROQ_MODEL",
    model: "openai/gpt-oss-120b", // Apache 2.0
    // gpt-oss can't switch reasoning off; "low" is its cheapest setting.
    reasoning: (effort, model) => (effort && /gpt-oss/i.test(model) ? (effort === "none" ? "low" : effort) : undefined),
  },
  {
    name: "nvidia",
    // NVIDIA's free developer API (build.nvidia.com), rate-limited per minute.
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyVar: "NVIDIA_API_KEY",
    modelVar: "NVIDIA_MODEL",
    model: "deepseek-ai/deepseek-v4.1-flash", // MIT
    reasoning: () => undefined,
  },
  {
    name: "openrouter",
    // Only ":free" models: they never bill, 50 requests a day without credits.
    baseUrl: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    model: "google/gemma-4-31b-it:free",
    reasoning: () => undefined,
    freeOnly: true,
  },
];

/** The providers whose keys are set, with the model each will use. */
export function configured(env) {
  return PROVIDERS.filter((p) => typeof env[p.keyVar] === "string" && env[p.keyVar].length > 0).map((p) => {
    let model = (typeof env[p.modelVar] === "string" && env[p.modelVar]) || p.model;
    // Never let a config change point OpenRouter at a paid model.
    if (p.freeOnly && !model.endsWith(":free")) model = p.model;
    return { ...p, model, key: env[p.keyVar] };
  });
}

/**
 * Try each provider in order. Returns {provider, body} from the first that answers,
 * or throws an Error with .status and .tried listing what failed.
 */
export async function fallback(providers, request, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const tried = [];
  let lastStatus = 429;
  for (const p of providers) {
    const reasoning = p.reasoning(request.reasoning_effort, p.model);
    const body = {
      model: p.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    };
    let res;
    try {
      res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      tried.push(`${p.name}: ${err?.name === "TimeoutError" ? "timed out" : "unreachable"}`);
      lastStatus = 502;
      continue;
    }
    if (res.ok) {
      const out = await res.json().catch(() => null);
      if (out?.choices?.length) return { provider: p.name, model: p.model, body: out };
      tried.push(`${p.name}: empty reply`);
      lastStatus = 502;
      continue;
    }
    // Any failure moves on: a rate limit or outage, a revoked key (401/403), or a request
    // this model rejects (400/422, for example a tool schema) may still work elsewhere.
    tried.push(`${p.name}: ${res.status}`);
    lastStatus = res.status;
  }
  throw Object.assign(new Error(`No free model available (${tried.join("; ") || "no fallback providers configured"})`), {
    status: lastStatus === 429 || !tried.length ? 429 : 502,
    tried,
  });
}
