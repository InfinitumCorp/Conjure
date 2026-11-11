// Conjure model gateway: open-weight models on Cloudflare Workers AI behind an
// OpenAI-compatible /v1/chat/completions endpoint, so Conjure's open-model backend
// (CONJURE_LLM_URL) can use them. Only callers holding GATEWAY_KEY get through.
//
// Free by construction: a Durable Object keeps a per-UTC-day neuron ledger and refuses
// calls once Workers AI's free daily allowance would be exceeded, so the account is never
// billed for Workers AI. Each call reserves its worst case up front, then settles to the
// real usage Workers AI reports, so concurrent calls can't overshoot.

import { DurableObject } from "cloudflare:workers";

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<any> };
  GATEWAY_KEY: string;
  DEFAULT_MODEL: string;
  /** Neurons per UTC day the gateway may spend. Workers AI gives 10,000 free; keep a margin. */
  DAILY_NEURONS: string;
}

import { budgetedAI, FreeAllowanceUsed } from "./ai-budget.js";

const day = () => new Date().toISOString().slice(0, 10);

/** One ledger for the whole gateway: neurons reserved or spent per UTC day. */
export class Budget extends DurableObject {
  async reserve(limit: number, amount: number): Promise<{ ok: boolean; used: number; limit: number }> {
    const key = day();
    const used = ((await this.ctx.storage.get<number>(key)) ?? 0);
    if (used + amount > limit) return { ok: false, used, limit };
    await this.ctx.storage.put(key, used + amount);
    return { ok: true, used: used + amount, limit };
  }

  async settle(key: string, reserved: number, actual: number): Promise<void> {
    const used = ((await this.ctx.storage.get<number>(key)) ?? 0);
    await this.ctx.storage.put(key, Math.max(0, used - reserved + actual));
    // Keep a week of history and nothing more.
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    await this.ctx.storage.delete(old);
  }

  async usage(limit: number): Promise<{ day: string; used: number; limit: number; remaining: number }> {
    const key = day();
    const used = ((await this.ctx.storage.get<number>(key)) ?? 0);
    return { day: key, used: Math.round(used * 100) / 100, limit, remaining: Math.max(0, Math.round((limit - used) * 100) / 100) };
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0 && b.length > 0;
}

/** Workers AI answers in either OpenAI shape or its own {response, tool_calls}; return OpenAI shape. */
function toOpenAI(result: any, model: string) {
  if (result?.choices) return { model, ...result };
  const calls = (result?.tool_calls ?? []).map((t: any, i: number) => {
    const args = t.arguments ?? t.function?.arguments ?? {};
    return { id: t.id ?? `call_${i + 1}`, type: "function", function: { name: t.name ?? t.function?.name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
  });
  const content = typeof result?.response === "string" ? result.response : result?.response == null ? "" : JSON.stringify(result.response);
  return {
    model,
    choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: result?.usage ?? {},
  };
}

const untilMidnightUtc = () => {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return Math.ceil((next.getTime() - Date.now()) / 1000);
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { exports: any }): Promise<Response> {
    const url = new URL(request.url);
    const limit = Number(env.DAILY_NEURONS) || 9500;
    const budget = () => ctx.exports.Budget.get(ctx.exports.Budget.idFromName("daily"));

    if (url.pathname === "/v1/health") return json({ ok: true, model: env.DEFAULT_MODEL });
    if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/usage") return json({ error: { message: "Not found" } }, 404);
    const auth = request.headers.get("authorization") ?? "";
    if (!(await sameKey(auth.replace(/^Bearer\s+/i, ""), env.GATEWAY_KEY ?? ""))) return json({ error: { message: "Unauthorized" } }, 401);
    if (url.pathname === "/v1/usage") return json(await budget().usage(limit));
    if (request.method !== "POST") return json({ error: { message: "Use POST" } }, 405);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "Send a JSON body" } }, 400);
    }
    if (!Array.isArray(body?.messages)) return json({ error: { message: "messages is required" } }, 400);
    const model = typeof body.model === "string" && body.model.startsWith("@cf/") ? body.model : env.DEFAULT_MODEL;
    let messages = body.messages;
    // reasoning_effort "none": Qwen3's documented switch to skip thinking, so the token budget goes to the answer.
    if (body.reasoning_effort === "none" && /qwen3/i.test(model)) {
      messages = messages.map((m: any, i: number) => (i === 0 && m.role === "system" && typeof m.content === "string" ? { ...m, content: `${m.content}\n/no_think` } : m));
    }
    const maxTokens = Math.min(Number(body.max_tokens) || 2000, 4096);
    const input: Record<string, unknown> = { messages, max_tokens: maxTokens };
    if (Array.isArray(body.tools) && body.tools.length) input.tools = body.tools;
    if (typeof body.temperature === "number") input.temperature = body.temperature;

    // Every call goes through the account-wide ledger (shared with the other Workers that use Workers AI).
    const ai = budgetedAI(env.AI, ctx.exports.Budget, { limit, waitUntil: (p) => ctx.waitUntil(p) });
    try {
      return json(toOpenAI(await ai.run(model, input), model));
    } catch (err) {
      if (err instanceof FreeAllowanceUsed) {
        return json(
          { error: { type: "free_allowance_used", message: "Conjure's free daily model allowance is used up. It resets at 00:00 UTC." } },
          429,
          { "retry-after": String(untilMidnightUtc()) },
        );
      }
      const message = (err as Error).message || "Model error";
      return json({ error: { message } }, /limit|quota|neuron|capacity/i.test(message) ? 429 : 502);
    }
  },
};
