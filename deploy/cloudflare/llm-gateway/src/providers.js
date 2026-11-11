// Free fallback providers for the Conjure model gateway.
//
// Workers AI runs first while its free daily allowance lasts. After that, or when it errors,
// the gateway tries each provider below in order. Every one serves open-weight models for
// free and cannot bill:
//   - Keyed providers (Groq, NVIDIA, OpenRouter) are used only when their key is stored as a
//     Worker secret, on free plans with no card attached.
//   - Keyless providers (OVHcloud AI Endpoints, Pollinations, LLM7) need no account at all.
//     They are rate-limited per IP and per model, so several models are listed to spread the
//     load. They are OFF unless KEYLESS_FALLBACKS="on": anonymous free tiers may log or train
//     on prompts, and Conjure's prompts carry client data, so turning them on is a deliberate
//     decision, not a default.
// A rate limit, outage, bad key or rejected request moves on to the next model.

/** Order matters: the first configured model that answers wins. */
export const PROVIDERS = [
  {
    name: "groq",
    // Free plan: 1,000 requests and 200,000 tokens a day per model.
    baseUrl: "https://api.groq.com/openai/v1",
    keyVar: "GROQ_API_KEY",
    modelVar: "GROQ_MODEL",
    models: ["openai/gpt-oss-120b"], // Apache 2.0
  },
  {
    name: "nvidia",
    // NVIDIA's free developer API (build.nvidia.com), rate-limited per minute.
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyVar: "NVIDIA_API_KEY",
    modelVar: "NVIDIA_MODEL",
    models: ["deepseek-ai/deepseek-v4.1-flash"], // MIT
  },
  {
    name: "openrouter",
    // Only ":free" models: they never bill, 50 requests a day without credits.
    baseUrl: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    models: ["google/gemma-4-31b-it:free"],
    freeOnly: true,
  },
  {
    name: "ovh",
    // OVHcloud AI Endpoints anonymous tier: no account, 2 requests a minute per IP per model.
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyless: true,
    models: [
      "gpt-oss-120b", // Apache 2.0
      "Qwen3.5-397B-A17B", // Apache 2.0
      "Qwen3.8-27B", // Apache 2.0
      "Meta-Llama-3_3-70B-Instruct", // Llama 3.3 Community License
      "Mistral-Small-3.2-24B-Instruct-2506", // Apache 2.0
    ],
  },
  {
    name: "pollinations",
    // Pollinations anonymous tier: no account; "openai-fast" is gpt-oss-20b served on OVH.
    baseUrl: "https://text.pollinations.ai/openai",
    path: "",
    keyless: true,
    models: ["openai-fast"],
  },
  {
    name: "llm7",
    // LLM7 anonymous access: no account, rate-limited per IP.
    baseUrl: "https://api.llm7.io/v1",
    keyless: true,
    models: ["gpt-oss:20b"], // Apache 2.0
  },
];

/** gpt-oss can't switch reasoning off; "low" is its cheapest setting. Other models get no hint. */
export const reasoningFor = (effort, model) => (effort && /gpt-oss/i.test(model) ? (effort === "none" ? "low" : effort) : undefined);

/** Every model the gateway may fall back to, in order, each with its provider's endpoint and key. */
export function configured(env) {
  const keylessOn = String(env.KEYLESS_FALLBACKS ?? "off").toLowerCase() === "on";
  const out = [];
  for (const p of PROVIDERS) {
    let key = "";
    let models = p.models;
    if (p.keyless) {
      if (!keylessOn) continue;
    } else {
      key = typeof env[p.keyVar] === "string" ? env[p.keyVar] : "";
      if (!key) continue;
      const override = typeof env[p.modelVar] === "string" ? env[p.modelVar] : "";
      // Never let a config change point OpenRouter at a paid model.
      if (override && (!p.freeOnly || override.endsWith(":free"))) models = [override];
    }
    const url = `${p.baseUrl}${p.path ?? "/chat/completions"}`;
    for (const model of models) out.push({ name: p.name, url, key, model, keyless: Boolean(p.keyless) });
  }
  return out;
}

/** Group configured models into one {name, models} entry per provider, for the usage report. */
export const summary = (list) =>
  list.reduce((acc, m) => {
    const last = acc[acc.length - 1];
    if (last?.name === m.name) last.models.push(m.model);
    else acc.push({ name: m.name, keyless: m.keyless, models: [m.model] });
    return acc;
  }, []);

/**
 * Try each model in order. Returns {provider, model, body} from the first that answers,
 * or throws an Error with .status and .tried listing what failed.
 */
export async function fallback(list, request, { fetchImpl = fetch, timeoutMs = 90_000 } = {}) {
  const tried = [];
  let limited = true;
  for (const m of list) {
    const reasoning = reasoningFor(request.reasoning_effort, m.model);
    const body = {
      model: m.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    };
    let res;
    try {
      res = await fetchImpl(m.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(m.key ? { authorization: `Bearer ${m.key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      tried.push(`${m.name}/${m.model}: ${err?.name === "TimeoutError" ? "timed out" : "unreachable"}`);
      limited = false;
      continue;
    }
    if (res.ok) {
      const out = await res.json().catch(() => null);
      const msg = out?.choices?.[0]?.message;
      // A reply with neither text nor a tool call (for example all tokens spent reasoning) is no answer.
      if (msg && (msg.tool_calls?.length || (typeof msg.content === "string" && msg.content.trim()))) {
        return { provider: m.name, model: m.model, body: out };
      }
      tried.push(`${m.name}/${m.model}: empty reply`);
      limited = false;
      continue;
    }
    tried.push(`${m.name}/${m.model}: ${res.status}`);
    if (res.status !== 429) limited = false;
  }
  throw Object.assign(new Error(`No free model available (${tried.join("; ") || "no fallback providers configured"})`), {
    status: limited ? 429 : 502,
    tried,
  });
}
