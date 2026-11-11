// Free fallback providers: only configured ones run, in order, moving on after any failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { configured, fallback } from "../deploy/cloudflare/llm-gateway/src/providers.js";

const reply = (text) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), { status: 200 });
const fail = (status) => new Response(JSON.stringify({ error: { message: "nope" } }), { status });

test("only providers with a key are used, in the documented order", () => {
  assert.deepEqual(configured({}), []);
  const names = configured({ OPENROUTER_API_KEY: "o", GROQ_API_KEY: "g" }).map((p) => p.name);
  assert.deepEqual(names, ["groq", "openrouter"]);
});

test("model overrides apply, but OpenRouter can never be pointed at a paid model", () => {
  const [groq, or] = configured({ GROQ_API_KEY: "g", GROQ_MODEL: "qwen/qwen3.8-27b", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "openai/gpt-5" });
  assert.equal(groq.model, "qwen/qwen3.8-27b");
  assert.equal(or.model, "google/gemma-4-31b-it:free");
  const [or2] = configured({ OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "nvidia/nemotron-3-ultra-550b-a55b:free" });
  assert.equal(or2.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
});

test("a rate-limited provider hands over to the next one", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return url.includes("groq") ? fail(429) : reply("from nvidia");
  };
  const out = await fallback(configured({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n" }), { messages: [{ role: "user", content: "hi" }], max_tokens: 100 }, { fetchImpl });
  assert.equal(out.provider, "nvidia");
  assert.equal(out.body.choices[0].message.content, "from nvidia");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].auth, "Bearer n");
  assert.equal(calls[1].body.model, "deepseek-ai/deepseek-v4.1-flash");
});

test("network errors and bad keys move on too", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    if (n === 2) return fail(401);
    return reply("ok");
  };
  const out = await fallback(configured({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n", OPENROUTER_API_KEY: "o" }), { messages: [], max_tokens: 10 }, { fetchImpl });
  assert.equal(out.provider, "openrouter");
});

test("reasoning 'none' becomes 'low' for gpt-oss and is dropped elsewhere", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? fail(503) : reply("ok");
  };
  await fallback(configured({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n" }), { messages: [], max_tokens: 10, reasoning_effort: "none" }, { fetchImpl });
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal("reasoning_effort" in bodies[1], false);
});

test("when every provider is limited the error is a 429 naming each one", async () => {
  await assert.rejects(
    fallback(configured({ GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" }), { messages: [], max_tokens: 10 }, { fetchImpl: async () => fail(429) }),
    (err) => err.status === 429 && /groq: 429; openrouter: 429/.test(err.message),
  );
  await assert.rejects(fallback([], { messages: [], max_tokens: 10 }), (err) => err.status === 429);
});

test("tools and temperature pass through unchanged", async () => {
  let sent;
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
  await fallback(configured({ GROQ_API_KEY: "g" }), { messages: [], max_tokens: 10, tools, temperature: 0.2 }, {
    fetchImpl: async (_u, init) => ((sent = JSON.parse(init.body)), reply("ok")),
  });
  assert.deepEqual(sent.tools, tools);
  assert.equal(sent.temperature, 0.2);
});
