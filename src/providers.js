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
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0f1115; color: #f2f2f2; }
  button { font-size: 1rem; padding: .7rem 1.4rem; border-radius: .5rem; border: 0; background: #7c5cff; color: white; cursor: pointer; }
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
