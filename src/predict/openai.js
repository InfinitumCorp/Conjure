// Open-source models for prediction runs through any OpenAI-compatible server:
// Ollama, llama.cpp, vLLM, LocalAI, or a hosted open-model API.
// The vendored engine speaks the Anthropic Messages format; this file translates both ways,
// so the engine stays a clean copy of Nexus.

const TIMEOUT_MS = Number(process.env.CONJURE_LLM_TIMEOUT_MS || 600_000);
// "none" turns thinking off on reasoning models (qwen3, gpt-oss) so the token budget goes to the answer.
const REASONING = process.env.CONJURE_LLM_REASONING || "";

/** Some servers inline the model's thinking; the engine only wants the answer. */
const answer = (text) => String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

async function chat({ baseUrl, model, apiKey, fetchImpl = fetch }, body) {
  return fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, ...(REASONING ? { reasoning_effort: REASONING } : {}), ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** One-shot text completion, the shape the simulation steps use. */
export function openaiComplete(cfg) {
  return async (system, user, opts) => {
    const res = await chat(cfg, {
      max_tokens: opts?.maxTokens ?? 2000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    if (!res.ok) throw new Error(`Model server error ${res.status}`);
    const body = await res.json();
    return answer(body.choices?.[0]?.message?.content);
  };
}

/** Anthropic Messages request (with tools) → chat completion → Anthropic Messages response. */
export function openaiAsAnthropicFetch(cfg) {
  let n = 0;
  return async (_url, init) => {
    const req = JSON.parse(String(init.body));
    const messages = [{ role: "system", content: req.system ?? "" }];
    for (const m of req.messages ?? []) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
      } else if (m.role === "assistant") {
        const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const calls = m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
        messages.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const b of m.content) {
          if (b.type === "tool_result") messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content) });
          else if (b.type === "text") messages.push({ role: "user", content: b.text });
        }
      }
    }
    const tools = (req.tools ?? []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const res = await chat(cfg, { max_tokens: req.max_tokens, messages, ...(tools.length ? { tools } : {}) });
    if (!res.ok) return res;
    const out = await res.json();
    const msg = out.choices?.[0]?.message ?? {};
    const content = [];
    if (answer(msg.content)) content.push({ type: "text", text: answer(msg.content) });
    for (const c of msg.tool_calls ?? []) {
      let input = {};
      try {
        input = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function?.arguments ?? {};
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: c.id || `call_${++n}`, name: c.function?.name ?? "", input });
    }
    const body = {
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: out.usage?.prompt_tokens ?? 0, output_tokens: out.usage?.completion_tokens ?? 0 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}
