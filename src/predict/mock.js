// Offline stand-in for Claude in prediction runs: deterministic, shaped like real replies,
// so the whole @conjure path (world → personas → rounds → report) works without a key.

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const ROLES = ["customer", "analyst", "regulator", "competitor", "journalist", "investor", "employee", "partner", "skeptic", "early adopter", "community lead", "supplier"];

export function mockComplete({ delayMs = 0 } = {}) {
  return async (system, user) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (system.includes("background brief")) {
      return `Background for the question. ${user.slice(0, 400)} Stakeholders include customers, competitors, regulators and the company's own team; recent signals are mixed and the outcome depends on timing and execution.`;
    }
    if (system.includes("map the world")) {
      return JSON.stringify({
        summary: "Offline mock world: a company, its customers, a competitor and a regulator react to the question.",
        poles: { for: "it happens", against: "it does not happen" },
        entities: [
          { id: "e1", name: "The company", kind: "organization", description: "Owner of the decision." },
          { id: "e2", name: "Customers", kind: "group", description: "People who buy and use the product." },
          { id: "e3", name: "Rival Co", kind: "organization", description: "Main competitor." },
          { id: "e4", name: "Regulator", kind: "organization", description: "Sets the rules." },
          { id: "e5", name: "Trade press", kind: "media", description: "Covers the market." },
        ],
        relations: [{ from: "e1", to: "e2", type: "sells to" }, { from: "e3", to: "e2", type: "competes for" }, { from: "e4", to: "e1", type: "regulates" }],
        facts: ["Demand grew last quarter", "A competitor cut prices", "New rules are under review"],
      });
    }
    if (system.includes("create diverse, realistic personas")) {
      const n = Number(/Create (\d+) new personas/.exec(user)?.[1] ?? 6);
      const start = (user.match(/Already created: (.*)/)?.[1] ?? "").split(",").filter((x) => x.trim() && x.trim() !== "none yet").length;
      return JSON.stringify({
        personas: Array.from({ length: n }, (_, i) => {
          const k = start + i;
          return {
            name: `Agent ${k + 1}`, entityId: `e${(k % 5) + 1}`, role: ROLES[k % ROLES.length], traits: "pragmatic",
            goals: "protect their interests", stance: Math.round((hash(`s${k}${user.slice(0, 80)}`) * 1.6 - 0.6) * 100) / 100,
            influence: 1 + (k % 5),
          };
        }),
      });
    }
    if (system.includes("play several people")) {
      const ids = [...user.matchAll(/AGENT (a\d+):/g)].map((m) => m[1]);
      const posts = [...user.matchAll(/\[(p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({
        actions: ids.map((id, i) => {
          const r = hash(`${id}${user.length}`);
          const action = posts.length && r < 0.35 ? (r < 0.15 ? "like" : "reply") : r < 0.8 ? "post" : "idle";
          return { agentId: id, action, text: `View from ${id}: the signals point ${r > 0.5 ? "toward yes" : "toward caution"}.`, targetPostId: posts[i % (posts.length || 1)], stanceShift: Math.round((r - 0.45) * 0.3 * 100) / 100, thought: "weighing the news" };
        }),
      });
    }
    if (system.startsWith("You are ")) return "Speaking as a simulated person: I moved a little as the round went on, mostly because of what others posted. (Offline mock answer.)";
    return "{}";
  };
}

/** A fetch stand-in for the report agent's Messages API calls: answers with a final JSON report. */
export function mockReportFetch() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = String(body.messages?.[0]?.content ?? "");
    const p = Math.round((0.35 + hash(text) * 0.4) * 100) / 100;
    const report = {
      outcome: `Offline mock forecast: a ${p >= 0.5 ? "slightly better than even" : "less than even"} chance it happens.`,
      probability: p,
      forecast: "This is an offline mock forecast produced without the Claude API. Agents split along their interests; the most influential voices moved opinion a little in early rounds and then settled. Add ANTHROPIC_API_KEY on the server for live forecasts.",
      drivers: ["Influential agents' early posts", "Price pressure from the competitor"],
      signals: ["Next quarter's demand numbers", "The regulator's decision"],
      assumptions: ["Seed material is accurate", "No major outside shock"],
      confidence: "low",
    };
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(report) }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
