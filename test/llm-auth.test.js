// Model-call signing: a fixed key, or the Yandex VM's own short-lived token.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { authHeaders, resetTokenCache } from "../src/llm-auth.js";

const saved = process.env.CONJURE_LLM_AUTH;
beforeEach(() => resetTokenCache());
afterEach(() => {
  if (saved === undefined) delete process.env.CONJURE_LLM_AUTH;
  else process.env.CONJURE_LLM_AUTH = saved;
});

const metadata = (answers) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift();
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  };
  return { fetchImpl, calls };
};

test("a fixed key is sent as a Bearer token; no key, no header", async () => {
  delete process.env.CONJURE_LLM_AUTH;
  assert.deepEqual(await authHeaders("k1"), { authorization: "Bearer k1" });
  assert.deepEqual(await authHeaders(""), {});
});

test("on a Yandex VM the metadata token is used, cached, and refreshed before it expires", async () => {
  process.env.CONJURE_LLM_AUTH = "yandex-vm";
  let t = 0;
  const now = () => t;
  const { fetchImpl, calls } = metadata([
    { body: { access_token: "iam-1", expires_in: 3600 } },
    { body: { access_token: "iam-2", expires_in: 3600 } },
  ]);
  assert.deepEqual(await authHeaders("ignored", { fetchImpl, now }), { authorization: "Bearer iam-1" });
  assert.equal(calls[0].url, "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token");
  assert.equal(calls[0].init.headers["metadata-flavor"], "Google");
  t = 30 * 60_000;
  assert.deepEqual(await authHeaders("", { fetchImpl, now }), { authorization: "Bearer iam-1" });
  assert.equal(calls.length, 1);
  t = 56 * 60_000; // inside the five-minute margin
  assert.deepEqual(await authHeaders("", { fetchImpl, now }), { authorization: "Bearer iam-2" });
});

test("waiting calls share one token request", async () => {
  process.env.CONJURE_LLM_AUTH = "yandex-vm";
  const { fetchImpl, calls } = metadata([{ body: { access_token: "iam", expires_in: 3600 } }]);
  const all = await Promise.all([1, 2, 3].map(() => authHeaders("", { fetchImpl })));
  assert.equal(calls.length, 1);
  assert.ok(all.every((h) => h.authorization === "Bearer iam"));
});

test("the VM token never goes to servers other than the shared model server", async () => {
  process.env.CONJURE_LLM_AUTH = "yandex-vm";
  const { fetchImpl, calls } = metadata([]);
  assert.deepEqual(await authHeaders("local", { vm: false, fetchImpl }), { authorization: "Bearer local" });
  assert.equal(calls.length, 0);
});

test("no service account on the VM gives a clear error", async () => {
  process.env.CONJURE_LLM_AUTH = "yandex-vm";
  const { fetchImpl } = metadata([{ status: 404, body: {} }]);
  await assert.rejects(authHeaders("", { fetchImpl }), /is a service account attached/);
});
