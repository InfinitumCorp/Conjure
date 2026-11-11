// Conjure model gateway: open-weight models on Cloudflare Workers AI behind an
// OpenAI-compatible /v1/chat/completions endpoint, so Conjure's open-model backend
// (CONJURE_LLM_URL) can use them. Only callers holding GATEWAY_KEY get through.

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<any> };
  GATEWAY_KEY: string;
  DEFAULT_MODEL: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") return json({ ok: true, model: env.DEFAULT_MODEL });
    if (url.pathname !== "/v1/chat/completions") return json({ error: { message: "Not found" } }, 404);
    if (request.method !== "POST") return json({ error: { message: "Use POST" } }, 405);
    const auth = request.headers.get("authorization") ?? "";
    if (!(await sameKey(auth.replace(/^Bearer\s+/i, ""), env.GATEWAY_KEY ?? ""))) return json({ error: { message: "Unauthorized" } }, 401);

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
    const input: Record<string, unknown> = { messages, max_tokens: Math.min(Number(body.max_tokens) || 2000, 4096) };
    if (Array.isArray(body.tools) && body.tools.length) input.tools = body.tools;
    if (typeof body.temperature === "number") input.temperature = body.temperature;

    try {
      return json(toOpenAI(await env.AI.run(model, input), model));
    } catch (err) {
      const message = (err as Error).message || "Model error";
      // Workers AI reports an exhausted daily allowance as an error; surface it as 429 so callers can tell.
      return json({ error: { message } }, /limit|quota|neuron|capacity/i.test(message) ? 429 : 502);
    }
  },
};
