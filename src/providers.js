// Model providers. Both return Anthropic-shaped messages ({content, stop_reason, usage})
// so the engine never needs to know which one it is talking to.
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";

export class ClaudeProvider {
  /**
   * @param {object} [o]
   * @param {number} [o.timeoutMs]   per-request timeout (SDK default: 10 minutes)
   * @param {number} [o.maxRetries]  retries for 408/409/429/5xx and connection errors
   */
  constructor({ model = DEFAULT_MODEL, fallbacks = true, client, timeoutMs, maxRetries = 3 } = {}) {
    this.name = "claude";
    this.model = model;
    this.fallbacks = fallbacks;
    const opts = { maxRetries };
    if (timeoutMs) opts.timeout = timeoutMs; // TypeScript SDK timeouts are in milliseconds
    this.clientOptions = opts;
    this.client = client ?? new Anthropic(opts);
  }

  /**
   * One streamed model turn.
   * @param {object} p
   * @param {string} p.system
   * @param {Anthropic.Beta.BetaMessageParam[]} p.messages
   * @param {Anthropic.Beta.BetaToolUnion[]} [p.tools]
   * @param {object} [p.jsonSchema]  structured-output schema for the final text
   * @param {string} [p.effort]
   * @param {(t: string) => void} [p.onText]
   */
  async turn({ system, messages, tools, jsonSchema, effort = "high", onText, phase, signal }) {
    const output_config = { effort };
    if (jsonSchema) output_config.format = { type: "json_schema", schema: jsonSchema };

    const params = {
      model: this.model,
      max_tokens: 64000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      output_config,
    };
    if (tools?.length) params.tools = tools;
    if (this.fallbacks) {
      // Server-side refusal fallback: on a policy decline the API re-runs the
      // request on a fallback model inside the same call.
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    let jsonRetries = 0;
    for (;;) {
      const stream = this.client.beta.messages.stream(params, signal ? { signal } : undefined);
      if (onText) stream.on("text", (d) => onText(d, phase));
      try {
        return await stream.finalMessage();
      } catch (err) {
        // With eager input streaming, an unparseable tool input rejects here.
        // Only that case is retried; real API errors and cancellation propagate.
        if (signal?.aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      }
    }
  }
}

/**
 * Offline provider: deterministic, scripted responses in the same shape as the
 * real API. Lets Conjure run end-to-end (and be tested) with no API key.
 * Set `flaw: true` to make the first build contain a syntax error so the
 * verify -> repair loop is exercised.
 */
export class MockProvider {
  constructor({ flaw = false, delayMs = 0 } = {}) {
    this.name = "mock";
    this.model = "mock";
    this.flaw = flaw;
    this.delayMs = delayMs;
    this.calls = 0;
    this.repaired = false;
  }

  async turn({ messages, jsonSchema, onText, phase, signal }) {
    this.calls++;
    if (this.delayMs) await abortableDelay(this.delayMs, signal);
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const intent = firstUserText(messages);
    const title = titleFrom(intent);
    const usage = { input_tokens: 0, output_tokens: 0 };

    const change = tagText(messages, "change");
    if (change !== null) {
      const alreadyWrote = messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"));
      if (alreadyWrote) return { role: "assistant", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage };
      onText?.(`Applying change: ${change}\n`, phase);
      return toolTurn([
        ["write_file", { path: "CHANGELOG.md", contents: `# Changelog\n\n- ${change}\n` }],
        ["finish", { summary: `Applied: ${change}` }],
      ]);
    }

    if (jsonSchema) {
      const plan = {
        name: title,
        summary: `A single-page web app for: ${intent}`,
        kind: "web-app",
        files: [
          { path: "index.html", purpose: "Page markup and layout" },
          { path: "app.js", purpose: "Interactive behaviour" },
          { path: "README.md", purpose: "How to open and use it" },
        ],
        acceptance: ["Opens directly in a browser", "Shows the app title", "Button responds to clicks"],
      };
      const text = JSON.stringify(plan);
      onText?.(text, phase);
      return { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage };
    }

    const last = messages[messages.length - 1];
    const lastResults = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
    const finishFailed = lastResults.some((r) => String(r.content).includes("VERIFICATION FAILED"));
    const alreadyWrote = messages.some(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
    );

    if (finishFailed && !this.repaired) {
      this.repaired = true;
      onText?.("Repairing app.js after verification failure.\n", phase);
      return toolTurn([
        ["write_file", { path: "app.js", contents: appJs(title, false) }],
        ["finish", { summary: `Built ${title} (repaired after verification).` }],
      ]);
    }

    if (!alreadyWrote) {
      onText?.(`Forging ${title}...\n`, phase);
      return toolTurn([
        ["write_file", { path: "index.html", contents: indexHtml(title) }],
        ["write_file", { path: "app.js", contents: appJs(title, this.flaw) }],
        ["write_file", { path: "README.md", contents: `# ${title}\n\nOpen \`index.html\` in a browser.\n\nConjured from: "${intent}"\n` }],
        ["finish", { summary: `Built ${title}.` }],
      ]);
    }

    return { role: "assistant", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage };
  }
}

// ---------------------------------------------------------------------------- Open weights

import { parseUrls, poolFor, redactMessages } from "./resilience.js";

/**
 * Keyless open-weight models for the forge loop: Ollama, llama.cpp, vLLM, LM
 * Studio or any other OpenAI-compatible /chat/completions server, run on
 * hardware Infinitum controls. No API key is needed or sent; `apiKey` stays
 * optional only for gateways that insist on a bearer header.
 *
 * Speaks the same Anthropic-shaped messages as ClaudeProvider, so the engine
 * never needs to know which one it is talking to. Non-streamed (like
 * MockProvider): the final text is handed to onText once, when it arrives.
 */
export const OPEN_WEIGHTS_DEFAULT_MODEL = "qwen3:8b";

export class OpenWeightsProvider {
  /** @param {object} [o] */
  constructor({ baseUrl, model, apiKey, fetchImpl = fetch, timeoutMs = 600_000 } = {}) {
    this.name = "open-weights";
    const env = process.env;
    // With no open-weight server of its own, the forge loop uses the conjure-llm gateway that
    // predictions already use (CONJURE_LLM_*): free open-weight models, Cloudflare Access included.
    this.viaGateway = !baseUrl && !env.CONJURE_OPEN_WEIGHTS_URL && Boolean(env.CONJURE_LLM_URL);
    // CONJURE_OPEN_WEIGHTS_URL (or the constructor's baseUrl) may list several
    // interchangeable servers, comma-separated; requests fail over down the list.
    this.urls = parseUrls(baseUrl || env.CONJURE_OPEN_WEIGHTS_URL || (this.viaGateway ? env.CONJURE_LLM_URL : ""), ["http://localhost:11434/v1"]);
    this.baseUrl = this.urls[0];
    this.model = model || env.CONJURE_OPEN_WEIGHTS_MODEL || (this.viaGateway ? env.CONJURE_LLM_MODEL : "") || env.CONJURE_MODEL || OPEN_WEIGHTS_DEFAULT_MODEL;
    this.apiKey = apiKey ?? env.CONJURE_OPEN_WEIGHTS_KEY ?? (this.viaGateway ? env.CONJURE_LLM_KEY ?? "" : "");
    this.extraHeaders = this.viaGateway
      ? {
          ...(env.CONJURE_LLM_ACCESS_ID && env.CONJURE_LLM_ACCESS_SECRET
            ? { "cf-access-client-id": env.CONJURE_LLM_ACCESS_ID, "cf-access-client-secret": env.CONJURE_LLM_ACCESS_SECRET }
            : {}),
          // Yandex Cloud AI Studio (Conjure Russia) wants the folder ID as OpenAI-Project.
          ...(env.CONJURE_LLM_PROJECT ? { "openai-project": env.CONJURE_LLM_PROJECT } : {}),
        }
      : {};
    // "none" skips Qwen3's thinking so the token budget goes to the answer.
    this.reasoning = this.viaGateway ? env.CONJURE_LLM_REASONING || "" : "";
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One call through the endpoint pool: retry with backoff, fail over between
   * the listed servers, trip a circuit breaker on a dead one, and strip
   * credentials from the prompt first (CONJURE_OPEN_WEIGHTS_REDACT=off disables).
   * @param {string} path
   * @param {RequestInit} init
   */
  fetch(path, init) {
    const intEnv = (name, fallback) => {
      const n = Number(process.env[name]);
      return Number.isInteger(n) && n >= 0 ? n : fallback;
    };
    let body = init.body;
    if (process.env.CONJURE_OPEN_WEIGHTS_REDACT !== "off" && typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.messages)) {
          const { messages, count } = redactMessages(parsed.messages);
          if (count) body = JSON.stringify({ ...parsed, messages });
        }
      } catch { /* not JSON: send as is */ }
    }
    const pool = poolFor(this.urls, { retries: intEnv("CONJURE_OPEN_WEIGHTS_RETRIES", 2), baseMs: intEnv("CONJURE_OPEN_WEIGHTS_RETRY_BASE_MS", 400) });
    return pool.fetch(path, { ...init, body }, { fetchImpl: this.fetchImpl });
  }

  /**
   * One model turn, same contract as ClaudeProvider.turn().
   * @param {object} p
   */
  async turn({ system, messages, tools, jsonSchema, onText, phase, signal }) {
    const body = {
      model: this.model,
      max_tokens: 64_000,
      messages: openWeightsMessages(system, messages),
      ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
      // Structured output for the plan step. Servers that predate response_format
      // (older llama.cpp) still answer; the plan is parsed and retried upstream.
      ...(jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "output", schema: jsonSchema } } } : {}),
      ...(this.reasoning ? { reasoning_effort: this.reasoning } : {}),
    };
    const res = await this.fetch("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.extraHeaders },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await openWeightsFailure(res);
    const out = await res.json();
    const msg = out.choices?.[0]?.message ?? {};
    // Some servers inline the model's thinking; the engine only wants the answer.
    const text = String(msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (text && onText) onText(text, phase);
    const content = [];
    if (text) content.push({ type: "text", text });
    for (const c of msg.tool_calls ?? []) {
      let input = {};
      try {
        input = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function?.arguments ?? {};
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: c.id || `toolu_ow_${++openWeightsCall}`, name: c.function?.name ?? "", input });
    }
    return {
      role: "assistant",
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: out.usage?.prompt_tokens ?? 0, output_tokens: out.usage?.completion_tokens ?? 0 },
    };
  }
}

let openWeightsCall = 0;

/** The model server's own error message, so a used-up allowance reads as such. */
async function openWeightsFailure(res) {
  const body = await res.json().catch(() => null);
  return Object.assign(new Error(body?.error?.message || `Model server error ${res.status}`), { status: res.status });
}

/** Anthropic messages (system + text/tool_use/tool_result blocks) → OpenAI chat messages. */
function openWeightsMessages(system, messages) {
  const out = [{ role: "system", content: system ?? "" }];
  for (const m of messages ?? []) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content) });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

let mockId = 0;
function toolTurn(calls) {
  return {
    role: "assistant",
    content: calls.map(([name, input]) => ({ type: "tool_use", id: `toolu_mock_${++mockId}`, name, input })),
    stop_reason: "tool_use",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

function tagText(messages, tag) {
  const c = messages[0]?.content;
  const text = typeof c === "string" ? c : (c?.find?.((b) => b.type === "text")?.text ?? "");
  const m = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  return m ? m[1].trim() : null;
}

function firstUserText(messages) {
  const c = messages[0]?.content;
  const text = typeof c === "string" ? c : (c?.find?.((b) => b.type === "text")?.text ?? "");
  const m = text.match(/<intent>\s*([\s\S]*?)\s*<\/intent>/);
  return (m ? m[1] : text).trim();
}

function titleFrom(intent) {
  const words = intent.replace(/[^\w\s-]/g, "").split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : "Conjured App";
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function indexHtml(title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #ffffff; color: #111820; }
  h1 { font-weight: 400; letter-spacing: -.055em; }
  button { font: inherit; padding: 17px 22px; border-radius: 0; border: 1px solid #111820; background: #111820; color: #fff; cursor: pointer; }
  button:hover { background: #2454dd; border-color: #2454dd; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p id="count">Clicked 0 times</p>
  <button id="go">Click me</button>
</main>
<script src="app.js"></script>
</body>
</html>
`;
}

function appJs(title, flawed) {
  const body = `let n = 0;
document.getElementById("go").addEventListener("click", () => {
  n++;
  document.getElementById("count").textContent = "Clicked " + n + " times";
});
console.log(${JSON.stringify(title)} + " ready");
`;
  return flawed ? body.replace("n++;", "n++;;) {") : body;
}
