// Open-source model backend: Anthropic Messages ⇄ OpenAI chat completions, against a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiComplete, openaiAsAnthropicFetch } from "../src/predict/openai.js";

function fakeServer(reply) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply(seen.at(-1).body)), { status: 200 });
  };
  return { seen, fetchImpl };
}

test("plain completions send system + user and return the text", async () => {
  const { seen, fetchImpl } = fakeServer(() => ({ choices: [{ message: { content: "hello" } }] }));
  const complete = openaiComplete({ baseUrl: "http://m/v1", model: "qwen2.5:3b", apiKey: "", fetchImpl });
  assert.equal(await complete("sys", "hi", { maxTokens: 50 }), "hello");
  assert.equal(seen[0].url, "http://m/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, undefined);
  assert.deepEqual(seen[0].body, { model: "qwen2.5:3b", max_tokens: 50, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] });
});

test("tool calls round-trip in both directions", async () => {
  const { seen, fetchImpl } = fakeServer((body) =>
    body.messages.some((m) => m.role === "tool")
      ? { choices: [{ message: { content: "Done." } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }
      : { choices: [{ message: { content: "", tool_calls: [{ function: { name: "trend", arguments: "{\"round\":2}" } }] } }] },
  );
  const f = openaiAsAnthropicFetch({ baseUrl: "http://m/v1", model: "m", apiKey: "k", fetchImpl });
  const tools = [{ name: "trend", description: "Stance trend", input_schema: { type: "object", properties: {} } }];
  const first = await (await f("https://api.anthropic.com/v1/messages", { body: JSON.stringify({ system: "s", max_tokens: 100, tools, messages: [{ role: "user", content: "go" }] }) })).json();
  assert.equal(first.stop_reason, "tool_use");
  assert.deepEqual(first.content, [{ type: "tool_use", id: "call_1", name: "trend", input: { round: 2 } }]);
  assert.equal(seen[0].headers.authorization, "Bearer k");
  assert.equal(seen[0].body.tools[0].function.name, "trend");

  const second = await (
    await f("x", {
      body: JSON.stringify({
        system: "s",
        tools,
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"up\":true}" }] },
        ],
      }),
    })
  ).json();
  assert.deepEqual(seen[1].body.messages.slice(2), [
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "trend", arguments: "{\"round\":2}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"up\":true}" },
  ]);
  assert.equal(second.stop_reason, "end_turn");
  assert.deepEqual(second.content, [{ type: "text", text: "Done." }]);
  assert.deepEqual(second.usage, { input_tokens: 9, output_tokens: 2 });
});

test("a used-up free allowance surfaces the gateway's message", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { type: "free_allowance_used", message: "Conjure's free daily model allowance is used up. It resets at 00:00 UTC." } }), { status: 429 });
  const cfg = { baseUrl: "http://m/v1", model: "m", apiKey: "k", fetchImpl };
  await assert.rejects(openaiComplete(cfg)("s", "u"), (e) => e.status === 429 && /free daily model allowance/.test(e.message));
  await assert.rejects(openaiAsAnthropicFetch(cfg)("x", { body: JSON.stringify({ system: "s", messages: [{ role: "user", content: "go" }] }) }), /resets at 00:00 UTC/);
});

test("a JSON step with broken syntax is asked again and the fixed reply is returned", async () => {
  const replies = ['{"personas": [{"name": "A"} {"name": "B"}]}', '{"personas": [{"name": "A"}, {"name": "B"}]}'];
  const { seen, fetchImpl } = fakeServer(() => ({ choices: [{ message: { content: replies.shift() } }] }));
  const out = await openaiComplete({ baseUrl: "http://m/v1", model: "m", apiKey: "", fetchImpl })("Reply in JSON.", "go");
  assert.deepEqual(JSON.parse(out).personas.length, 2);
  assert.equal(seen.length, 2);
  assert.match(seen[1].body.messages.at(-1).content, /not valid JSON/);
});

test("modelUsage reads the gateway's ledger and is null when unreachable", async () => {
  const { modelUsage } = await import("../src/predict/openai.js");
  const ok = await modelUsage({ baseUrl: "http://g/v1", apiKey: "k", fetchImpl: async (url, init) => {
    assert.equal(url, "http://g/v1/usage");
    assert.equal(init.headers.authorization, "Bearer k");
    return new Response(JSON.stringify({ day: "2026-11-11", used: 565.7, limit: 9500, remaining: 8934.3 }));
  } });
  assert.equal(ok.remaining, 8934.3);
  assert.equal(await modelUsage({ baseUrl: "http://g/v1", fetchImpl: async () => { throw new Error("down"); } }), null);
  assert.equal(await modelUsage({ baseUrl: "" }), null);
});

test("thinking adds its own budget on top of each call's answer budget", async () => {
  const { withThinking } = await import("../src/predict/openai.js");
  assert.equal(withThinking(600, true, 4096), 4696);
  assert.equal(withThinking(600, false, 4096), 600);
  assert.equal(withThinking(undefined, true, 4096), undefined);
});
