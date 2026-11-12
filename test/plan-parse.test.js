// The planner's reply is parsed leniently and retried once, for open-weight models
// that ignore structured output.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { parsePlan, conjure, ConjureError } from "../src/engine.js";

const plan = { name: "Todo", summary: "A list", kind: "web-app", files: [{ path: "index.html", purpose: "page" }], acceptance: ["opens"] };

test("parsePlan reads bare JSON, fenced JSON and JSON wrapped in prose", () => {
  assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
  assert.deepEqual(parsePlan("```json\n" + JSON.stringify(plan) + "\n```"), plan);
  assert.deepEqual(parsePlan("Here is the plan:\n" + JSON.stringify(plan) + "\nDone."), plan);
});

test("parsePlan rejects prose and JSON without a name and files", () => {
  assert.equal(parsePlan("<plan>1. Make index.html</plan>"), null);
  assert.equal(parsePlan(JSON.stringify({ files: ["index.html"] })), null);
  assert.equal(parsePlan(""), null);
  assert.deepEqual(parsePlan(JSON.stringify({ name: "x", files: [] })).acceptance, []);
});

/** A provider whose plan replies come from a list; the forge step is never reached here. */
function scripted(replies) {
  const calls = [];
  return {
    calls,
    name: "scripted",
    model: "test",
    async turn(req) {
      calls.push(req);
      const text = replies.shift();
      if (text === undefined) throw new Error("stop after plan");
      return { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

test("a prose plan is retried once with the schema, and the second answer is used", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "conjure-plan-"));
  const p = scripted(["<plan>1. index.html</plan>", JSON.stringify(plan)]);
  const events = [];
  await assert.rejects(conjure({ intent: "a todo list", provider: p, outDir: out, onEvent: (e) => events.push(e) }), /stop after plan/);
  assert.equal(p.calls.length, 3); // plan, retry, then the first forge turn
  assert.equal(p.calls[1].messages.length, 3);
  assert.match(p.calls[1].messages[2].content, /not a JSON object/);
  assert.ok(events.some((e) => e.type === "plan" && e.plan.name === "Todo"));
});

test("two prose plans in a row fail with the planner error", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "conjure-plan-"));
  const p = scripted(["no json", "still no json"]);
  await assert.rejects(conjure({ intent: "a todo list", provider: p, outDir: out }), (e) => e instanceof ConjureError && /valid JSON/.test(e.message));
  assert.equal(p.calls.length, 2);
});
