// Synced from infinitum-nexus packages/scalus/src/llm.ts @ 330d5a0. Do not edit here; edit Nexus and re-run scripts/sync-nexus.mjs.
/**
 * SCALVS.ai agent engine: Claude plans, calls tools, reads the results and continues
 * until it can answer (the Anthropic Messages API tool-use loop).
 *
 * Human approval: tools marked `effect: "propose"` never run during the agent's turn.
 * The call becomes a Proposal the host product shows to a person, who approves or
 * dismisses it. "Agents draft and recommend; your team approves anything that reaches
 * a customer."
 */

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** "read" runs immediately. "propose" is queued for human approval and never runs here. */
  effect: "read" | "propose";
  /** For read tools: the result returned to the model. */
  run?(input: Record<string, unknown>): Promise<unknown> | unknown;
  /** For propose tools: a one-line, human-readable description of what approving will do. */
  describe?(input: Record<string, unknown>): string;
}

export interface Proposal {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface Step {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
  /** True when the step was a proposal awaiting approval. */
  proposed?: boolean;
  error?: string;
}

export interface LlmAgentResult {
  output: string;
  steps: Step[];
  proposals: Proposal[];
  usage: { inputTokens: number; outputTokens: number; calls: number };
  stopReason: "done" | "step_limit";
}

export interface LlmConfig {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** Max model calls per run (each may request several tools). Default 8. */
  maxSteps?: number;
  maxTokens?: number;
  /** Id generator for proposals (injected in tests). */
  newId?: () => string;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}

export class LlmError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Cap what one tool result can add to the conversation. */
function serialize(result: unknown, limit = 12_000): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > limit ? `${text.slice(0, limit)}… [truncated ${text.length - limit} characters]` : text;
}

export async function runLlmAgent(
  cfg: LlmConfig,
  agent: { system: string; tools: LlmTool[] },
  prompt: string,
): Promise<LlmAgentResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const maxSteps = cfg.maxSteps ?? 8;
  const newId = cfg.newId ?? (() => `prop_${crypto.randomUUID()}`);
  const byName = new Map(agent.tools.map((t) => [t.name, t]));
  const messages: Message[] = [{ role: "user", content: prompt }];
  const steps: Step[] = [];
  const proposals: Proposal[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  for (let i = 0; i < maxSteps; i++) {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 2000,
        system: agent.system,
        tools: agent.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
        messages,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new LlmError(`Claude API error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, res.status);
    }
    const body = (await res.json()) as { content?: Block[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    usage.calls++;
    usage.inputTokens += body.usage?.input_tokens ?? 0;
    usage.outputTokens += body.usage?.output_tokens ?? 0;
    const content = body.content ?? [];
    messages.push({ role: "assistant", content });

    const calls = content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (body.stop_reason !== "tool_use" || calls.length === 0) {
      const output = content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
      return { output, steps, proposals, usage, stopReason: "done" };
    }

    const results: Block[] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      const input = call.input ?? {};
      if (!tool) {
        steps.push({ tool: call.name, input, result: null, error: "unknown tool" });
        results.push({ type: "tool_result", tool_use_id: call.id, content: `No tool named ${call.name}.`, is_error: true });
        continue;
      }
      if (tool.effect === "propose") {
        const proposal: Proposal = { id: newId(), tool: tool.name, input, summary: tool.describe?.(input) ?? `${tool.name}` };
        proposals.push(proposal);
        steps.push({ tool: tool.name, input, result: { queuedForApproval: proposal.id }, proposed: true });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Queued for human approval as ${proposal.id}. It has NOT happened yet; say so in your answer.`,
        });
        continue;
      }
      try {
        const result = await tool.run!(input);
        steps.push({ tool: tool.name, input, result });
        results.push({ type: "tool_result", tool_use_id: call.id, content: serialize(result) });
      } catch (err) {
        const message = (err as Error).message;
        steps.push({ tool: tool.name, input, result: null, error: message });
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Error: ${message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return {
    output: "I reached my step limit before finishing. Here's what I found so far; ask me to continue with a narrower request.",
    steps,
    proposals,
    usage,
    stopReason: "step_limit",
  };
}
