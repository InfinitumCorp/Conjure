// Free fallback providers: keyed ones only with a key, keyless ones only when switched on, in order,
// moving on to the next model after any failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { configured, fallback, summary } from "../deploy/cloudflare/llm-gateway/src/providers.js";

const reply = (text) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), { status: 200 });
const fail = (status) => new Response(JSON.stringify({ error: { message: "nope" } }), { status });
const ON = { KEYLESS_FALLBACKS: "on" };
const names = (list) => [...new Set(list.map((m) => m.name))];

test("keyless providers stay off unless switched on, and come after keyed ones", () => {
  assert.deepEqual(configured({}), []);
  assert.deepEqual(names(configured({ GROQ_API_KEY: "g" })), ["groq"]);
  assert.deepEqual(names(configured({ KEYLESS_FALLBACKS: "on" })), ["ovh", "pollinations", "llm7"]);
  assert.deepEqual(names(configured({ ...ON, OPENROUTER_API_KEY: "o", GROQ_API_KEY: "g" })), ["groq", "openrouter", "ovh", "pollinations", "llm7"]);
  assert.equal(configured({ KEYLESS_FALLBACKS: "off" }).length, 0);
  assert.ok(configured(ON).every((m) => m.key === "" && m.keyless));
});

test("OVH spreads load over several models", () => {
  const ovh = configured(ON).filter((m) => m.name === "ovh");
  assert.ok(ovh.length >= 5);
  assert.equal(ovh[0].url, "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions");
  assert.equal(configured(ON).find((m) => m.name === "pollinations").url, "https://text.pollinations.ai/openai");
  assert.deepEqual(summary(configured(ON)).map((s) => [s.name, s.models.length > 0]), [["ovh", true], ["pollinations", true], ["llm7", true]]);
});

test("model overrides apply, but OpenRouter can never be pointed at a paid model", () => {
  const off = { KEYLESS_FALLBACKS: "off" };
  assert.equal(configured({ ...off, GROQ_API_KEY: "g", GROQ_MODEL: "qwen/qwen3.8-27b" })[0].model, "qwen/qwen3.8-27b");
  assert.equal(configured({ ...off, OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "openai/gpt-5" })[0].model, "google/gemma-4-31b-it:free");
  assert.equal(configured({ ...off, OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "nvidia/nemotron-3-ultra-550b-a55b:free" })[0].model, "nvidia/nemotron-3-ultra-550b-a55b:free");
});

test("a rate-limited model hands over to the next one, with no auth header for keyless", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return calls.length < 3 ? fail(429) : reply("third time");
  };
  const out = await fallback(configured(ON), { messages: [{ role: "user", content: "hi" }], max_tokens: 100 }, { fetchImpl });
  assert.equal(out.provider, "ovh");
  assert.equal(out.model, calls[2].body.model);
  assert.notEqual(calls[0].body.model, calls[1].body.model);
  assert.ok(calls.every((c) => c.auth === undefined));
});

test("keyed providers send their key", async () => {
  let auth;
  await fallback(configured({ GROQ_API_KEY: "g" }), { messages: [], max_tokens: 10 }, { fetchImpl: async (_u, init) => ((auth = init.headers.authorization), reply("ok")) });
  assert.equal(auth, "Bearer g");
});

test("network errors, bad keys and empty replies move on", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    if (n === 2) return fail(401);
    if (n === 3) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", reasoning: "thinking..." } }] }));
    return reply("ok");
  };
  const out = await fallback(configured({ ...ON, GROQ_API_KEY: "g", NVIDIA_API_KEY: "n" }), { messages: [], max_tokens: 10 }, { fetchImpl });
  assert.equal(n, 4);
  assert.equal(out.provider, "ovh");
});

test("a tool call with no text counts as an answer", async () => {
  const toolReply = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] } }] }));
  const out = await fallback(configured(ON), { messages: [], max_tokens: 10 }, { fetchImpl: async () => toolReply });
  assert.equal(out.body.choices[0].message.tool_calls[0].function.name, "f");
});

test("reasoning 'none' becomes 'low' for gpt-oss and is dropped elsewhere", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? fail(503) : reply("ok");
  };
  await fallback(configured(ON), { messages: [], max_tokens: 10, reasoning_effort: "none" }, { fetchImpl });
  assert.equal(bodies[0].model, "gpt-oss-120b");
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal("reasoning_effort" in bodies[1], false);
});

test("when every model is rate-limited the error is a 429 naming each one", async () => {
  const list = configured({ KEYLESS_FALLBACKS: "off", GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" });
  await assert.rejects(
    fallback(list, { messages: [], max_tokens: 10 }, { fetchImpl: async () => fail(429) }),
    (err) => err.status === 429 && /groq\/openai\/gpt-oss-120b: 429; openrouter\/google\/gemma-4-31b-it:free: 429/.test(err.message),
  );
  await assert.rejects(fallback([], { messages: [], max_tokens: 10 }), (err) => err.status === 429);
  await assert.rejects(fallback(list, { messages: [], max_tokens: 10 }, { fetchImpl: async () => fail(500) }), (err) => err.status === 502);
});

test("tools and temperature pass through unchanged", async () => {
  let sent;
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
  await fallback(configured(ON), { messages: [], max_tokens: 10, tools, temperature: 0.2 }, {
    fetchImpl: async (_u, init) => ((sent = JSON.parse(init.body)), reply("ok")),
  });
  assert.deepEqual(sent.tools, tools);
  assert.equal(sent.temperature, 0.2);
});
