// @conjure: the mention parser, the prediction API for products, staff accounts and the dashboard API.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConjureMention, formatForecast, createConjure } from "../client/conjure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner-token-xyz789";

async function startServer(extraEnv = {}) {
  const port = 46000 + Math.floor(Math.random() * 900) * 2;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-pred-"));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CONJURE_MOCK: "1", PORT: String(port), PREVIEW_PORT: String(port + 1), CONJURE_OUT: path.join(tmp, "out"), CONJURE_DATA: path.join(tmp, "data"), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
    if (i === 99) throw new Error(`server did not start:\n${log}`);
  }
  return { base, stop: () => child.kill(), log: () => log };
}

const auth = (t) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

describe("@conjure mentions", () => {
  test("finds the question after the mention, with the text before as context", () => {
    assert.deepEqual(parseConjureMention("Acme's CFO went quiet. @conjure will Acme sign by March?"), { question: "will Acme sign by March?", context: "Acme's CFO went quiet." });
  });
  test("uses the text before when nothing follows", () => {
    assert.equal(parseConjureMention("Will rates fall in June? @Conjure").question, "Will rates fall in June?");
  });
  test("ignores emails, longer handles and plain text", () => {
    for (const t of ["write to sales@conjure.com", "@conjured it", "conjure this", "x/@conjure", ""]) assert.equal(parseConjureMention(t), null, t);
  });
  test("a bare mention has an empty question", () => {
    assert.deepEqual(parseConjureMention("@conjure"), { question: "", context: "" });
  });
  test("formats a finished forecast as a reply", () => {
    const text = formatForecast({ question: "q", agents: 16, rounds: 3, poles: { for: "it signs" }, report: { outcome: "Likely signs late.", probability: 0.62, confidence: "medium", drivers: ["budget"], signals: ["legal review"] } });
    assert.match(text, /62% likely that it signs/);
    assert.match(text, /Drivers: budget/);
  });
});

describe("prediction service with staff sign-in", () => {
  let s, productKey, staffToken, issuer;
  before(async () => {
    // Stand-in Cumulus ID issuer: the code is the cid of the person who signed in.
    issuer = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const { code } = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "t", profile: { cid: code, username: code } }));
    });
    await new Promise((r) => issuer.listen(0, "127.0.0.1", r));
    s = await startServer({ CONJURE_ACCESS_TOKEN: OWNER, CONJURE_MOCK_DELAY: "5", CID_ISSUER: `http://127.0.0.1:${issuer.address().port}` });
  });
  after(() => {
    s.stop();
    issuer.close();
  });

  test("the dashboard needs a staff sign-in", async () => {
    assert.equal((await fetch(`${s.base}/`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${s.base}/api/admin/overview`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/health`)).status, 401);
    const page = await fetch(`${s.base}/`, { headers: { authorization: `Bearer ${OWNER}` } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Try @conjure/);
  });

  test("an admin issues a product key, shown once and stored hashed", async () => {
    const r = await fetch(`${s.base}/api/admin/products`, { method: "POST", headers: auth(OWNER), body: JSON.stringify({ slug: "spectre", dailyLimit: 3 }) });
    assert.equal(r.status, 201);
    const body = await r.json();
    productKey = body.key;
    assert.match(productKey, /^cjp_spectre_/);
    assert.equal(body.product.hash, undefined);
    const ov = await (await fetch(`${s.base}/api/admin/overview`, { headers: auth(OWNER) })).json();
    assert.ok(!JSON.stringify(ov).includes(productKey), "the overview never repeats a key");
    assert.equal((await fetch(`${s.base}/api/admin/products`, { method: "POST", headers: auth(OWNER), body: JSON.stringify({ slug: "spectre" }) })).status, 400, "one active key per product");
  });

  test("a product key reaches only /v1", async () => {
    assert.equal((await fetch(`${s.base}/v1/health`, { headers: auth(productKey) })).status, 200);
    assert.equal((await fetch(`${s.base}/api/admin/overview`, { headers: auth(productKey) })).status, 403);
    assert.equal((await fetch(`${s.base}/api/history`, { headers: auth(productKey) })).status, 403);
    const login = await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: productKey }), redirect: "manual" });
    assert.notEqual(login.status, 303, "a product key can't sign in to the dashboard");
  });

  test("the client turns an @conjure message into a finished forecast", async () => {
    const conjure = createConjure({ url: s.base, key: productKey, pollMs: 50 });
    assert.equal(await conjure.handleMention("no mention here"), null);
    const seen = [];
    const result = await conjure.handleMention("Deal notes: champion left. @conjure will Acme renew this year?", { user: "u_1", source: "deal", rounds: 2, agents: 6, onProgress: (p) => seen.push(p.status) });
    assert.equal(result.prediction.status, "done", JSON.stringify(result.prediction));
    assert.equal(result.prediction.product, "spectre");
    assert.equal(result.prediction.round, 2);
    assert.ok(result.prediction.report.probability >= 0 && result.prediction.report.probability <= 1);
    assert.match(result.text, /Conjure™ forecast/);
    assert.ok(seen.includes("done"));
    const answer = await conjure.interview(result.prediction.id, "a1", "Why?");
    assert.ok(answer.answer.length > 0);
  });

  test("products see only their own forecasts; staff see all", async () => {
    const other = await (await fetch(`${s.base}/api/admin/products`, { method: "POST", headers: auth(OWNER), body: JSON.stringify({ slug: "mail" }) })).json();
    const mine = await (await fetch(`${s.base}/v1/predictions`, { headers: auth(productKey) })).json();
    assert.ok(mine.length >= 1);
    assert.equal((await (await fetch(`${s.base}/v1/predictions`, { headers: auth(other.key) })).json()).length, 0);
    assert.equal((await fetch(`${s.base}/v1/predictions/${mine[0].id}`, { headers: auth(other.key) })).status, 404);
    assert.equal((await fetch(`${s.base}/v1/predictions/${mine[0].id}`, { headers: auth(OWNER) })).status, 200);
  });

  test("bad input is refused and the daily limit holds", async () => {
    const bad = await fetch(`${s.base}/v1/predictions`, { method: "POST", headers: auth(productKey), body: JSON.stringify({ question: "" }) });
    assert.equal(bad.status, 400);
    for (let i = 0; i < 2; i++) await fetch(`${s.base}/v1/predictions`, { method: "POST", headers: auth(productKey), body: JSON.stringify({ question: `q${i}`, rounds: 1, agents: 4 }) });
    const over = await fetch(`${s.base}/v1/predictions`, { method: "POST", headers: auth(productKey), body: JSON.stringify({ question: "one too many" }) });
    assert.equal(over.status, 429);
  });

  test("rotating a key retires the old one at once", async () => {
    const ov = await (await fetch(`${s.base}/api/admin/overview`, { headers: auth(OWNER) })).json();
    const id = ov.products.find((p) => p.slug === "spectre" && !p.revokedAt).id;
    const r = await (await fetch(`${s.base}/api/admin/products/${id}/rotate`, { method: "POST", headers: auth(OWNER), body: "{}" })).json();
    assert.equal((await fetch(`${s.base}/v1/health`, { headers: auth(productKey) })).status, 401);
    assert.equal((await fetch(`${s.base}/v1/health`, { headers: auth(r.key) })).status, 200);
  });

  test("staff get their own tokens; staff can view but not change keys; revoking signs them out", async () => {
    const add = await (await fetch(`${s.base}/api/admin/staff`, { method: "POST", headers: auth(OWNER), body: JSON.stringify({ name: "Ada", role: "staff", cid: "cid_ada" }) })).json();
    staffToken = add.token;
    // Staff sign in with their Cumulus ID; the cjs_ token is for scripts.
    const start = await fetch(`${s.base}/auth/cid/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const login = await fetch(`${s.base}/auth/cid/callback?code=cid_ada&state=${state}`, { redirect: "manual", headers: { cookie: start.headers.get("set-cookie").split(";")[0] } });
    assert.equal(login.status, 303);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("conjure_session=")).split(";")[0];
    assert.ok(!cookie.includes(staffToken));
    const ov = await (await fetch(`${s.base}/api/admin/overview`, { headers: { cookie } })).json();
    assert.equal(ov.me.name, "Ada");
    assert.equal(ov.staff, undefined, "staff can't list staff");
    assert.equal((await fetch(`${s.base}/api/admin/products`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ slug: "eon" }) })).status, 403);
    await fetch(`${s.base}/api/admin/staff/${add.staff.id}/revoke`, { method: "POST", headers: auth(OWNER), body: "{}" });
    assert.equal((await fetch(`${s.base}/api/admin/overview`, { headers: { cookie } })).status, 401);
  });

  test("a forecast streams live over server-sent events", async () => {
    const started = await (await fetch(`${s.base}/v1/predictions`, { method: "POST", headers: auth(OWNER), body: JSON.stringify({ question: "will it rain on launch day?", rounds: 2, agents: 4 }) })).json();
    const text = await (await fetch(`${s.base}/v1/predictions/${started.id}/events`, { headers: auth(OWNER) })).text();
    const events = text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
    assert.equal(events.at(-1).status, "done");
    assert.ok(events.length >= 3, `expected progress events, got ${events.length}`);
    assert.equal(events.at(-1).product, "dashboard");
  });
});

describe("drop-in @conjure routes for products", async () => {
  const { createConjureRoutes } = await import("../client/conjure.mjs");
  let s, key, handle;
  before(async () => {
    s = await startServer({ CONJURE_ACCESS_TOKEN: OWNER, CONJURE_MOCK_DELAY: "1" });
    key = (await (await fetch(`${s.base}/api/admin/products`, { method: "POST", headers: auth(OWNER), body: JSON.stringify({ slug: "hrvst" }) })).json()).key;
    handle = createConjureRoutes({ conjure: createConjure({ url: s.base, key, pollMs: 20 }), secret: key });
  });
  after(() => s.stop());
  const post = (body) => new Request("https://product.test/api/conjure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("ignores other paths and needs a signed-in user", async () => {
    assert.equal(await handle(new Request("https://product.test/api/other"), { user: "u1" }), null);
    assert.equal((await handle(post({ text: "@conjure x?" }), {})).status, 401);
  });

  test("no mention is a no-op; a mention starts a forecast only its asker can follow", async () => {
    assert.deepEqual(await (await handle(post({ text: "hello" }), { user: "u1" })).json(), { mention: false });
    const r = await (await handle(post({ text: "@conjure will the pilot convert?", source: "note" }), { user: "u1" })).json();
    assert.equal(r.mention, true);
    assert.match(r.ticket, /^pr_[\w-]+\.[\w-]+$/);
    assert.equal(r.prediction.product, "hrvst");
    let follow;
    for (let i = 0; i < 100; i++) {
      follow = await (await handle(new Request(`https://product.test/api/conjure/${r.ticket}`), { user: "u1" })).json();
      if (follow.prediction.status === "done") break;
      await new Promise((res) => setTimeout(res, 30));
    }
    assert.match(follow.text, /Conjure™ forecast/);
    assert.equal((await handle(new Request(`https://product.test/api/conjure/${r.ticket}`), { user: "u2" })).status, 404, "someone else can't follow it");
    const forged = r.ticket.replace(/\.[\w-]+$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal((await handle(new Request(`https://product.test/api/conjure/${forged}`), { user: "u1" })).status, 404);
  });

  test("answers 503 when Conjure isn't configured", async () => {
    const off = createConjureRoutes({ conjure: null, secret: "x" });
    assert.equal((await off(post({ text: "@conjure q" }), { user: "u1" })).status, 503);
  });
});

test("live only: with no model configured, a forecast is refused rather than faked", async () => {
  const saved = { m: process.env.CONJURE_MOCK, u: process.env.CONJURE_LLM_URL, k: process.env.ANTHROPIC_API_KEY };
  process.env.CONJURE_MOCK = ""; process.env.CONJURE_LLM_URL = ""; process.env.ANTHROPIC_API_KEY = "";
  try {
    const { modelSetup } = await import("../src/predict/service.js");
    assert.throws(() => modelSetup({}), /No live model/);
    assert.equal(modelSetup({ mock: true }).mode, "mock");
  } finally {
    process.env.CONJURE_MOCK = saved.m ?? ""; process.env.CONJURE_LLM_URL = saved.u ?? ""; process.env.ANTHROPIC_API_KEY = saved.k ?? "";
  }
});
