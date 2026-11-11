// Account-wide Workers AI budget: reserve the worst case, settle to real usage, refuse past the cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetedAI, FreeAllowanceUsed, worstCase } from "../deploy/cloudflare/llm-gateway/src/ai-budget.js";

/** In-memory stand-in for the Budget Durable Object namespace. */
function fakeLedger() {
  const days = new Map();
  const stub = {
    async reserve(limit, amount) {
      const d = new Date().toISOString().slice(0, 10);
      const used = days.get(d) ?? 0;
      if (used + amount > limit) return { ok: false, used, limit };
      days.set(d, used + amount);
      return { ok: true, used: used + amount, limit };
    },
    async settle(day, reserved, actual) {
      days.set(day, Math.max(0, (days.get(day) ?? 0) - reserved + actual));
    },
  };
  return { ns: { idFromName: () => "daily", get: () => stub }, used: () => [...days.values()][0] ?? 0 };
}

const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const input = { messages: [{ role: "user", content: "hello" }], max_tokens: 100 };

test("a call settles to the neurons Workers AI reports", async () => {
  const ledger = fakeLedger();
  const ai = budgetedAI({ run: async () => ({ response: "hi", usage: { neurons: 1.5 } }) }, ledger.ns, { limit: 100 });
  assert.equal((await ai.run(MODEL, input)).response, "hi");
  assert.equal(ledger.used(), 1.5);
});

test("calls are refused once the day's allowance would be exceeded, and the model is not called", async () => {
  const ledger = fakeLedger();
  let calls = 0;
  const ai = budgetedAI({ run: async () => (calls++, { usage: { neurons: 0 } }) }, ledger.ns, { limit: worstCase(MODEL, input) * 1.5 });
  await ai.run(MODEL, input);
  await ai.run(MODEL, input); // settled to 0, so room remains
  const big = { ...input, max_tokens: 8000 };
  await assert.rejects(ai.run(MODEL, big), FreeAllowanceUsed);
  assert.equal(calls, 2);
});

test("failed calls are not charged; unknown usage keeps the reservation", async () => {
  const ledger = fakeLedger();
  const failing = budgetedAI({ run: async () => { throw new Error("boom"); } }, ledger.ns, { limit: 100 });
  await assert.rejects(failing.run(MODEL, input), /boom/);
  assert.equal(ledger.used(), 0);
  const silent = budgetedAI({ run: async () => ({ response: "x" }) }, ledger.ns, { limit: 100 });
  await silent.run(MODEL, input);
  assert.equal(ledger.used(), worstCase(MODEL, input));
});

test("without a ledger binding the AI binding is returned unchanged", () => {
  const ai = { run: async () => ({}) };
  assert.equal(budgetedAI(ai, undefined), ai);
});
