// Conjure Russia runs on Yandex Cloud AI Studio, which needs the folder ID as OpenAI-Project.
import { test } from "node:test";
import assert from "node:assert/strict";

const YANDEX = {
  CONJURE_LLM_URL: "https://ai.api.cloud.yandex.net/v1",
  CONJURE_LLM_KEY: "yc-key",
  CONJURE_LLM_PROJECT: "b1gfolder",
  CONJURE_LLM_MODEL: "gpt://b1gfolder/gpt-oss-120b/latest",
  CONJURE_LLM_REASONING: "low",
  CONJURE_LLM_ACCESS_ID: undefined,
  CONJURE_LLM_ACCESS_SECRET: undefined,
  CONJURE_OPEN_WEIGHTS_URL: undefined,
  CONJURE_OPEN_WEIGHTS_MODEL: undefined,
  CONJURE_OPEN_WEIGHTS_KEY: undefined,
};
for (const [k, v] of Object.entries(YANDEX)) v === undefined ? delete process.env[k] : (process.env[k] = v);

const ok = (content) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });

test("predictions send the Yandex folder header and no Cloudflare Access headers", async () => {
  const { openaiComplete } = await import(`../src/predict/openai.js?yandex=${Date.now()}`);
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }), ok("forecast"));
  const complete = openaiComplete({ baseUrl: YANDEX.CONJURE_LLM_URL, model: YANDEX.CONJURE_LLM_MODEL, apiKey: YANDEX.CONJURE_LLM_KEY, fetchImpl });
  assert.equal(await complete("system", "user"), "forecast");
  assert.equal(seen[0].url, "https://ai.api.cloud.yandex.net/v1/chat/completions");
  assert.equal(seen[0].headers["openai-project"], "b1gfolder");
  assert.equal(seen[0].headers.authorization, "Bearer yc-key");
  assert.equal(seen[0].headers["cf-access-client-id"], undefined);
  assert.equal(seen[0].body.model, "gpt://b1gfolder/gpt-oss-120b/latest");
  assert.equal(seen[0].body.reasoning_effort, "low");
});

test("code generation uses the same Yandex settings", async () => {
  const { OpenWeightsProvider } = await import("../src/providers.js");
  const seen = [];
  const p = new OpenWeightsProvider({ fetchImpl: async (url, init) => (seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }), ok("code")) });
  await p.turn({ system: "s", messages: [{ role: "user", content: "build" }] });
  assert.equal(seen[0].url, "https://ai.api.cloud.yandex.net/v1/chat/completions");
  assert.equal(seen[0].headers["openai-project"], "b1gfolder");
  assert.equal(seen[0].body.model, "gpt://b1gfolder/gpt-oss-120b/latest");
});
