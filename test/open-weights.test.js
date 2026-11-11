// OpenWeightsProvider: keyless open-weight models for the forge loop, against a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenWeightsProvider } from "../src/providers.js";

function fakeServer(reply) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply(seen.at(-1).body)), { status: 200 });
  };
  return { seen, fetchImpl };
}

const make = (cfg, reply) => {
  const { seen, fetchImpl } = fakeServer(reply);
  const p = new OpenWeightsProvider({ baseUrl: "http://m/v1", model: "qwen3:8b", fetchImpl, ...cfg });
  return { seen, fetchImpl, p };
};

test("a plain turn sends system + user with no auth header, and returns Anthropic-shaped text", async () => {
  const { seen, p } = make({}, () => ({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
  const out = await p.turn({ system: "sys", messages: [{ role: "user", content: "hi" }] });
  assert.equal(seen[0].url, "http://m/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, undefined);
  assert.deepEqual(seen[0].body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
  assert.equal(seen[0].body.model, "qwen3:8b");
  assert.deepEqual(out.content, [{ type: "text", text: "hello" }]);
  assert.equal(out.stop_reason, "end_turn");
  assert.deepEqual(out.usage, { input_tokens: 4, output_tokens: 1 });
});

test("inlined <think> reasoning is stripped from the answer", async () => {
  const { p } = make({}, () => ({ choices: [{ message: { content: "<think>ponder</think>done" } }] }));
  const out = await p.turn({ system: "s", messages: [{ role: "user", content: "go" }] });
  assert.deepEqual(out.content, [{ type: "text", text: "done" }]);
});

test("tool calls round-trip in both directions", async () => {
  const tools = [{ name: "write_file", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const { seen, p } = make(
    {},
    (body) =>
      body.messages.some((m) => m.role === "tool")
        ? { choices: [{ message: { content: "Done." } }] }
        : { choices: [{ message: { content: "", tool_calls: [{ id: "call_1", function: { name: "write_file", arguments: "{\"path\":\"app.js\"}" } }] } }] },
  );
  const first = await p.turn({ system: "s", tools, messages: [{ role: "user", content: "go" }] });
  assert.equal(first.stop_reason, "tool_use");
  assert.deepEqual(first.content, [{ type: "tool_use", id: "call_1", name: "write_file", input: { path: "app.js" } }]);
  assert.equal(seen[0].body.tools[0].function.name, "write_file");

  const second = await p.turn({
    system: "s",
    tools,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ],
  });
  assert.deepEqual(seen[1].body.messages.slice(2), [
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"app.js\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ]);
  assert.equal(second.stop_reason, "end_turn");
  assert.deepEqual(second.content, [{ type: "text", text: "Done." }]);
});

test("a jsonSchema plan request asks for a json_schema response", async () => {
  const { seen, p } = make({}, () => ({ choices: [{ message: { content: "{}" } }] }));
  await p.turn({ system: "s", messages: [{ role: "user", content: "go" }], jsonSchema: { type: "object", properties: { name: { type: "string" } } } });
  assert.deepEqual(seen[0].body.response_format, { type: "json_schema", json_schema: { name: "output", schema: { type: "object", properties: { name: { type: "string" } } } } });
});

test("the server's own error message surfaces, with its status", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "free allowance used up" } }), { status: 429 });
  const p = new OpenWeightsProvider({ baseUrl: "http://m/v1", fetchImpl });
  await assert.rejects(() => p.turn({ system: "s", messages: [{ role: "user", content: "go" }] }), (err) => err.message === "free allowance used up" && err.status === 429);
});

test("a bearer header is sent only when a key is given", async () => {
  const withKey = make({ apiKey: "k" }, () => ({ choices: [{ message: { content: "x" } }] }));
  await withKey.p.turn({ system: "s", messages: [{ role: "user", content: "go" }] });
  assert.equal(withKey.seen[0].headers.authorization, "Bearer k");
  const noKey = make({}, () => ({ choices: [{ message: { content: "x" } }] }));
  await noKey.p.turn({ system: "s", messages: [{ role: "user", content: "go" }] });
  assert.equal(noKey.seen[0].headers.authorization, undefined);
});
