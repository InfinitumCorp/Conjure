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

test("a dead first server fails over to the second, and the prompt is redacted first", async () => {
  process.env.CONJURE_OPEN_WEIGHTS_RETRIES = "0";
  const key = "ghp_" + "A".repeat(36);
  const seen = [];
  const { p } = make(
    { baseUrl: "http://a/v1,http://b/v1" },
    (body) =>
      body.messages.some((m) => /REDACTED/.test(JSON.stringify(m.content)))
        ? { choices: [{ message: { content: "ok" } }] }
        : { choices: [{ message: { content: "x" } }] },
  );
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: init.body });
    return url.startsWith("http://a") ? new Response("{}", { status: 500 }) : Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  p.fetchImpl = fetchImpl;
  const out = await p.turn({ system: "s", messages: [{ role: "user", content: `deploy with ${key}` }] });
  assert.deepEqual(seen.map((s) => s.url), ["http://a/v1/chat/completions", "http://b/v1/chat/completions"]);
  assert.ok(seen.every((s) => !s.body.includes(key) && s.body.includes("REDACTED:github-token")));
  assert.equal(out.content[0].text, "ok");
  delete process.env.CONJURE_OPEN_WEIGHTS_RETRIES;
});

test("CONJURE_OPEN_WEIGHTS_REDACT=off sends the prompt unmodified", async () => {
  process.env.CONJURE_OPEN_WEIGHTS_RETRIES = "0";
  process.env.CONJURE_OPEN_WEIGHTS_REDACT = "off";
  const key = "ghp_" + "A".repeat(36);
  let sent = null;
  const { p } = make({ baseUrl: "http://a/v1" }, () => ({ choices: [{ message: { content: "x" } }] }));
  p.fetchImpl = async (url, init) => { sent = init.body; return Response.json({ choices: [{ message: { content: "x" } }] }); };
  await p.turn({ system: "s", messages: [{ role: "user", content: `deploy with ${key}` }] });
  assert.ok(sent.includes(key));
  delete process.env.CONJURE_OPEN_WEIGHTS_RETRIES;
  delete process.env.CONJURE_OPEN_WEIGHTS_REDACT;
});

/** Runs fn with these environment variables set, restoring the old values afterwards. */
async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

const GATEWAY = {
  CONJURE_OPEN_WEIGHTS_URL: undefined,
  CONJURE_OPEN_WEIGHTS_MODEL: undefined,
  CONJURE_OPEN_WEIGHTS_KEY: undefined,
  CONJURE_LLM_URL: "https://gw.example/v1",
  CONJURE_LLM_KEY: "gw-key",
  CONJURE_LLM_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8",
  CONJURE_LLM_ACCESS_ID: "access-id",
  CONJURE_LLM_ACCESS_SECRET: "access-secret",
  CONJURE_LLM_REASONING: "none",
};

test("with no open-weight server of its own, the forge loop uses the conjure-llm gateway", async () => {
  await withEnv(GATEWAY, async () => {
    const { seen, fetchImpl } = fakeServer(() => ({ choices: [{ message: { content: "ok" } }] }));
    const p = new OpenWeightsProvider({ fetchImpl });
    assert.equal(p.viaGateway, true);
    await p.turn({ system: "s", messages: [{ role: "user", content: "go" }] });
    assert.equal(seen[0].url, "https://gw.example/v1/chat/completions");
    assert.equal(seen[0].headers.authorization, "Bearer gw-key");
    assert.equal(seen[0].headers["cf-access-client-id"], "access-id");
    assert.equal(seen[0].headers["cf-access-client-secret"], "access-secret");
    assert.equal(seen[0].body.model, "@cf/qwen/qwen3-30b-a3b-fp8");
    assert.equal(seen[0].body.reasoning_effort, "none");
  });
});

test("an explicit open-weight server wins over the gateway and gets none of its credentials", async () => {
  await withEnv({ ...GATEWAY, CONJURE_OPEN_WEIGHTS_URL: "http://own/v1" }, async () => {
    const { seen, fetchImpl } = fakeServer(() => ({ choices: [{ message: { content: "ok" } }] }));
    const p = new OpenWeightsProvider({ fetchImpl });
    assert.equal(p.viaGateway, false);
    await p.turn({ system: "s", messages: [{ role: "user", content: "go" }] });
    assert.equal(seen[0].url, "http://own/v1/chat/completions");
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers["cf-access-client-id"], undefined);
    assert.equal("reasoning_effort" in seen[0].body, false);
  });
});

test("the gateway alone is enough to pick open weights over the mock", async () => {
  const { openWeightsConfigured } = await import("../src/config.js");
  await withEnv({ ...GATEWAY }, async () => assert.equal(openWeightsConfigured(), true));
  await withEnv({ ...GATEWAY, CONJURE_LLM_URL: undefined }, async () => assert.equal(openWeightsConfigured(), false));
});

test("a jsonSchema request also spells the schema out in the system prompt", async () => {
  const schema = { type: "object", properties: { files: { type: "array" } }, required: ["files"] };
  const { seen, p } = make({}, () => ({ choices: [{ message: { content: "{\"files\":[]}" } }] }));
  await p.turn({ system: "plan it", messages: [{ role: "user", content: "go" }], jsonSchema: schema });
  const sys = seen[0].body.messages[0];
  assert.equal(sys.role, "system");
  assert.ok(sys.content.startsWith("plan it\n\nReply with only one JSON object"));
  assert.ok(sys.content.includes(JSON.stringify(schema)));
});
