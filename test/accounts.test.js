// Public accounts: every Cumulus ID builds in its own space. One account can't see, cancel,
// refine or download another's builds; admins can see all. Plans come from the Cumulus billing hub.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { AccessStore } from "../src/access.js";
import { PlanLookup, conjurePlanFrom } from "../src/plans.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let nextPort = 49000 + Math.floor(Math.random() * 800) * 2;
const TOKEN = "accounts-test-token";
const json = { "content-type": "application/json" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in Cumulus ID issuer and billing hub in one server. */
async function fakeCumulus() {
  const people = {
    owner: { cid: "cid_owner", username: "william" },
    alice: { cid: "cid_alice", username: "alice" },
    bob: { cid: "cid_bob", username: "bob" },
    carol: { cid: "cid_carol", username: "carol" },
  };
  // What each person pays for, keyed by their access token.
  const billing = {
    tok_bob_0123456789abcdef: [{ product: "conjure", plan: "conjure_pro", status: "active" }],
    tok_alice_0123456789abcdef: [{ product: "scalvs", plan: "scalvs_pro", status: "active" }],
  };
  const billingCalls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "GET" && req.url === "/api/billing/me") {
      const tok = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
      billingCalls.push(tok);
      if (!tok || !tok.startsWith("tok_")) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Not signed in"}');
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ cid: "x", plans: {}, features: [], creditsCents: 0, products: billing[tok] ?? [] }));
    }
    if (req.method !== "POST" || req.url !== "/api/id/token") return res.writeHead(404).end();
    const b = JSON.parse(body);
    const profile = people[b.code];
    if (!profile) return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad code"}');
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `tok_${b.code}_0123456789abcdef`, expires_in: 3600, profile }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, billingCalls, close: () => server.close() };
}

async function startServer(env) {
  const port = nextPort;
  nextPort += 2;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CONJURE_MOCK: "1", PORT: String(port), PREVIEW_PORT: String(port + 1), ...env },
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
    await wait(50);
    if (i === 99) throw new Error(`server did not start:\n${log}`);
  }
  return { base, preview: `http://127.0.0.1:${port + 1}`, stop: () => child.kill() };
}

async function signIn(base, code) {
  const start = await fetch(`${base}/auth/cid/start`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const pending = start.headers.get("set-cookie").split(";")[0];
  const r = await fetch(`${base}/auth/cid/callback?code=${code}&state=${state}`, { redirect: "manual", headers: { cookie: pending } });
  assert.equal(r.status, 303, `${code} should sign in`);
  const set = r.headers.getSetCookie();
  return set.filter((c) => /^conjure_(session|cid)=[^;]/.test(c)).map((c) => c.split(";")[0]).join("; ");
}

async function readStream(res) {
  const text = await res.text();
  return text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
}

const get = (s, cookie, p) => fetch(`${s.base}${p}`, { headers: { cookie } });
const status = async (s, cookie) => (await get(s, cookie, "/api/status")).json();
const post = (s, cookie, p, body, signal) =>
  fetch(`${s.base}${p}`, { method: "POST", headers: { cookie, ...json }, body: body === undefined ? undefined : JSON.stringify(body), signal });

/** Starts a run and drops the connection; the run keeps going on the server. */
async function startDetached(s, cookie, intent) {
  const ctrl = new AbortController();
  const r = await post(s, cookie, "/api/conjure", { intent }, ctrl.signal);
  ctrl.abort();
  return r.status;
}

async function settle(s, cookie) {
  for (let i = 0; i < 200; i++) {
    if (!(await status(s, cookie)).busy) return;
    await wait(50);
  }
  throw new Error("run did not finish");
}

describe("accounts are isolated from each other", () => {
  let s, hub, owner, alice, bob, aliceDir, aliceSpace;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-acct-"));

  before(async () => {
    hub = await fakeCumulus();
    s = await startServer({
      CONJURE_ACCESS_TOKEN: TOKEN, CID_ISSUER: hub.url, CONJURE_BILLING_URL: hub.url, CID_OWNERS: "cid_owner",
      CONJURE_OUT: path.join(tmp, "out"), CONJURE_DATA: path.join(tmp, "data"), CONJURE_MOCK_DELAY: "120",
    });
    owner = await signIn(s.base, "owner");
    alice = await signIn(s.base, "alice");
    bob = await signIn(s.base, "bob");
    const r = await post(s, alice, "/api/conjure", { intent: "a coin flipper" });
    assert.equal(r.status, 200);
    const done = (await readStream(r)).find((e) => e.type === "done");
    assert.ok(done, "alice's build finished");
    aliceDir = done.dir;
    aliceSpace = (await status(s, alice)).previewBase.split("/").pop();
  });
  after(() => {
    s?.stop();
    hub?.close();
  });

  test("each account has its own, unguessable space", async () => {
    const bobSpace = (await status(s, bob)).previewBase.split("/").pop();
    assert.match(aliceSpace, /^k_[0-9a-f]{24}$/);
    assert.notEqual(aliceSpace, bobSpace);
    assert.equal((await fetch(`${s.preview}/${aliceSpace}/${aliceDir}/index.html`)).status, 200);
  });

  test("B does not see A's builds in history", async () => {
    const mine = await (await get(s, alice, "/api/history")).json();
    assert.ok(mine.some((h) => h.dir === aliceDir));
    const theirs = await (await get(s, bob, "/api/history")).json();
    assert.equal(theirs.length, 0);
    const sneaky = await (await get(s, bob, `/api/history?all=1&space=${aliceSpace}`)).json();
    assert.equal(sneaky.length, 0, "?all and ?space are admin-only");
  });

  test("B cannot download A's build, even naming A's space", async () => {
    assert.equal((await get(s, alice, `/api/download?dir=${aliceDir}`)).status, 200);
    assert.equal((await get(s, bob, `/api/download?dir=${aliceDir}`)).status, 404);
    assert.equal((await get(s, bob, `/api/download?dir=${aliceDir}&space=${aliceSpace}`)).status, 404);
    assert.equal((await get(s, bob, `/api/download?dir=${encodeURIComponent(`../${aliceSpace}/${aliceDir}`)}`)).status, 400);
  });

  test("B cannot refine A's build", async () => {
    const r = await post(s, bob, "/api/refine", { dir: aliceDir, change: "make it red" });
    assert.equal(r.status, 404);
  });

  test("B cannot see or cancel A's run in progress", async () => {
    assert.equal(await startDetached(s, alice, "a slow stopwatch"), 200);
    await wait(50);
    const a = await status(s, alice);
    assert.equal(a.busy, true);
    const runId = a.jobs[0].id;
    const b = await status(s, bob);
    assert.equal(b.busy, false, "B's status doesn't show A's run");
    assert.equal(b.job, null);
    assert.equal((await post(s, bob, `/api/cancel?id=${runId}`)).status, 404);
    assert.deepEqual(await (await post(s, bob, "/api/cancel")).json(), { cancelled: false });
    assert.equal((await status(s, alice)).busy, true, "A's run is still going");
    assert.deepEqual(await (await post(s, alice, `/api/cancel?id=${runId}`)).json(), { cancelled: true });
    await settle(s, alice);
  });

  test("each account has its own concurrency limit", async () => {
    // Alice is on Free (one run at a time); Bob is on Pro (two).
    assert.equal(await startDetached(s, alice, "a timer"), 200);
    assert.equal((await post(s, alice, "/api/conjure", { intent: "another" })).status, 409);
    assert.equal(await startDetached(s, bob, "a clock"), 200, "Alice's run doesn't block Bob");
    assert.equal(await startDetached(s, bob, "a second clock"), 200, "Pro runs two at once");
    assert.equal((await post(s, bob, "/api/conjure", { intent: "a third" })).status, 409);
    await post(s, alice, "/api/cancel");
    await post(s, bob, "/api/cancel");
    await settle(s, alice);
    await settle(s, bob);
  });

  test("an admin sees, downloads and cancels every account's builds", async () => {
    const all = await (await get(s, owner, "/api/history?all=1")).json();
    const hit = all.find((h) => h.dir === aliceDir);
    assert.equal(hit?.space, aliceSpace);
    assert.equal((await get(s, owner, `/api/download?dir=${aliceDir}&space=${aliceSpace}`)).status, 200);
    assert.equal((await get(s, owner, `/api/download?dir=${aliceDir}`)).status, 404, "without ?space an admin reads their own space");
    assert.equal(await startDetached(s, alice, "a pomodoro"), 200);
    await wait(50);
    const everyone = await (await get(s, owner, "/api/status?all=1")).json();
    const run = everyone.allJobs.find((j) => j.by === "alice");
    assert.ok(run);
    assert.equal((await post(s, owner, `/api/cancel?id=${run.id}`)).status, 200);
    await settle(s, alice);
  });

  test("plans come from the billing hub with the person's own Cumulus ID token", async () => {
    const a = (await status(s, alice)).plan;
    const b = (await status(s, bob)).plan;
    assert.equal(a.id, "conjure_free");
    assert.equal(b.id, "conjure_pro");
    assert.equal(b.concurrent, 2);
    assert.ok(hub.billingCalls.includes("tok_bob_0123456789abcdef"));
    assert.ok(hub.billingCalls.includes("tok_alice_0123456789abcdef"));
    assert.ok(a.used >= 1, "alice's verified build counts toward her month");
    const links = a.links;
    assert.equal(new URL(links.pro).origin, hub.url);
    assert.equal(new URL(links.pro).pathname, "/api/billing/subscribe");
    assert.equal(new URL(links.pro).searchParams.get("plan"), "conjure_pro");
    assert.equal(new URL(links.team).searchParams.get("plan"), "conjure_team");
    assert.equal(new URL(links.manage).pathname, "/api/billing/manage");
    assert.match(new URL(links.pro).searchParams.get("return"), /\/studio$/);
    const ownerPlan = (await status(s, owner)).plan;
    assert.equal(ownerPlan.id, "staff");
    assert.equal(ownerPlan.links, undefined);
  });

  test("the token cookie only works for the account it was issued to", async () => {
    // Bob's sealed token pasted next to Alice's session doesn't give Alice Bob's plan.
    const bobToken = bob.split("; ").find((c) => c.startsWith("conjure_cid="));
    const aliceSession = alice.split("; ").find((c) => c.startsWith("conjure_session="));
    const mixed = await (await get(s, `${aliceSession}; ${bobToken}`, "/api/status?plan=refresh")).json();
    assert.equal(mixed.plan.id, "conjure_free");
  });
});

describe("monthly build allowance", () => {
  let s, hub, carol;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-quota-"));
  before(async () => {
    // Carol has already used her five Free builds this month.
    const store = await new AccessStore({ file: path.join(tmp, "data", "access.json"), ownerToken: TOKEN }).load();
    const who = await store.userByCid({ cid: "cid_carol", username: "carol" });
    for (let i = 0; i < 5; i++) await store.countBuild(who);
    hub = await fakeCumulus();
    s = await startServer({
      CONJURE_ACCESS_TOKEN: TOKEN, CID_ISSUER: hub.url, CONJURE_BILLING_URL: hub.url,
      CONJURE_OUT: path.join(tmp, "out"), CONJURE_DATA: path.join(tmp, "data"),
    });
    carol = await signIn(s.base, "carol");
  });
  after(() => {
    s?.stop();
    hub?.close();
  });

  test("a Free account that used its builds is asked to upgrade", async () => {
    const st = await status(s, carol);
    assert.equal(st.plan.used, 5);
    assert.equal(st.plan.builds, 5);
    const r = await post(s, carol, "/api/conjure", { intent: "a coin flipper" });
    assert.equal(r.status, 402);
    assert.match(await r.text(), /Upgrade/);
  });
});

describe("plan lookup", () => {
  test("only an active, trialing or past-due Conjure subscription counts", () => {
    assert.equal(conjurePlanFrom({ products: [{ product: "conjure", plan: "conjure_pro", status: "active" }] }), "conjure_pro");
    assert.equal(conjurePlanFrom({ products: [{ product: "conjure", plan: "conjure_team", status: "trialing" }] }), "conjure_team");
    assert.equal(conjurePlanFrom({ products: [{ product: "conjure", plan: "conjure_pro", status: "canceled" }] }), "conjure_free");
    assert.equal(conjurePlanFrom({ products: [{ product: "scalvs", plan: "scalvs_pro", status: "active" }] }), "conjure_free");
    assert.equal(conjurePlanFrom({ products: [{ product: "conjure", plan: "conjure_enterprise", status: "active" }] }), "conjure_free");
    assert.equal(conjurePlanFrom(null), "conjure_free");
  });

  test("an unreachable hub keeps the last known plan, and a missing token falls back to Free", async () => {
    let up = true;
    const fetchImpl = async () => {
      if (!up) throw new Error("offline");
      return new Response(JSON.stringify({ products: [{ product: "conjure", plan: "conjure_pro", status: "active" }] }), { status: 200 });
    };
    const p = new PlanLookup({ hub: "https://hub.example", fetchImpl, ttlMs: 0 });
    assert.equal((await p.planFor("u1", "tok")).plan.id, "conjure_pro");
    up = false;
    const down = await p.planFor("u1", "tok");
    assert.equal(down.plan.id, "conjure_pro");
    assert.equal(down.status, "unavailable");
    const none = await new PlanLookup({ fetchImpl }).planFor("u2", null);
    assert.equal(none.plan.id, "conjure_free");
    assert.equal(none.status, "signin");
  });

  test("Conjure never holds a Stripe key", () => {
    for (const dir of ["src", "public"]) {
      for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
        const file = path.join(root, dir, String(f));
        if (!fs.statSync(file).isFile() || !/\.(js|mjs|html|json)$/.test(file)) continue;
        assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|STRIPE_SECRET/, file);
      }
    }
  });
});
