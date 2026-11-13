// Integration tests for the web server: sign-in, request checks, headers, previews
// and runs that outlive their connection. Each suite starts a real server process.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let nextPort = 47000 + Math.floor(Math.random() * 1000) * 2;

async function startServer(extraEnv = {}) {
  const port = nextPort;
  nextPort += 2;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-srv-"));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CONJURE_MOCK: "1", PORT: String(port), PREVIEW_PORT: String(port + 1), CONJURE_OUT: out, CONJURE_DATA: path.join(out, "..", path.basename(out) + "-data"), ...extraEnv },
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
  return { base, preview: `http://127.0.0.1:${port + 1}`, out, stop: () => child.kill() };
}

const TOKEN = "test-token-abc123";
const json = { "content-type": "application/json" };

async function readStream(res) {
  const text = await res.text();
  return text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
}

/** A stand-in Cumulus ID issuer: the code names the person who signed in. */
async function fakeIssuer() {
  const people = { owner: { cid: "cid_owner", username: "william", name: "William", email: "william@cumuluscloud.app" }, stranger: { cid: "cid_stranger", username: "nobody" } };
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method !== "POST" || req.url !== "/api/id/token") return res.writeHead(404).end();
    const b = JSON.parse(body);
    seen.push(b);
    const profile = people[b.code];
    if (!profile || b.client_id !== "conjure" || !b.code_verifier) return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad code"}');
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "t", profile }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

/** Starts sign-in, then returns from the issuer with `code`. Resolves to the callback response. */
async function signIn(base, code, headers = {}) {
  const start = await fetch(`${base}/auth/cid/start`, { redirect: "manual", headers });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const pending = start.headers.get("set-cookie").split(";")[0];
  return fetch(`${base}/auth/cid/callback?code=${code}&state=${state}`, { redirect: "manual", headers: { ...headers, cookie: pending } });
}

describe("server with sign-in (CONJURE_ACCESS_TOKEN set)", () => {
  let s;
  let cookie;
  let issuer;
  before(async () => {
    issuer = await fakeIssuer();
    s = await startServer({ CONJURE_ACCESS_TOKEN: TOKEN, CID_ISSUER: issuer.url, CID_OWNERS: "cid_owner", CONJURE_FRONT_HOSTS: "front.example" });
  });
  after(() => {
    s.stop();
    issuer.close();
  });

  test("health check and icons need no sign-in", async () => {
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.base}/icon-192.png`)).status, 200);
  });

  test("pages redirect to /login and the API answers 401 without a session", async () => {
    const page = await fetch(`${s.base}/`, { redirect: "manual" });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "/login");
    assert.equal((await fetch(`${s.base}/api/history`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/download?dir=x`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/conjure`, { method: "POST", headers: json, body: "{}" })).status, 401);
  });

  test("the sign-in page offers Cumulus ID and Create, and no token field", async () => {
    const html = await (await fetch(`${s.base}/login`)).text();
    assert.match(html, /Sign in with Cumulus ID/);
    assert.match(html, /Create a Cumulus ID/);
    assert.doesNotMatch(html, /type="password"/);
    assert.equal((await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: TOKEN }), redirect: "manual" })).status, 405);
  });

  test("start sends people to the issuer with PKCE, and Create asks for the create screen", async () => {
    const r = await fetch(`${s.base}/auth/cid/start?create=1`, { redirect: "manual" });
    const to = new URL(r.headers.get("location"));
    assert.equal(to.origin + to.pathname, `${issuer.url}/api/id/authorize`);
    assert.equal(to.searchParams.get("client_id"), "conjure");
    assert.equal(to.searchParams.get("code_challenge_method"), "S256");
    assert.equal(to.searchParams.get("redirect_uri"), `${s.base}/auth/cid/callback`);
    assert.equal(to.searchParams.get("prompt"), "create");
  });

  test("sign-in through a listed front hostname returns there; an unlisted one is ignored", async () => {
    const via = (host) => fetch(`${s.base}/auth/cid/start`, { redirect: "manual", headers: { "x-forwarded-host": host } })
      .then((r) => new URL(r.headers.get("location")).searchParams.get("redirect_uri"));
    assert.equal(await via("front.example"), "https://front.example/auth/cid/callback");
    assert.equal(await via("FRONT.example"), "https://front.example/auth/cid/callback");
    assert.equal(await via("evil.example"), `${s.base}/auth/cid/callback`);
  });

  test("any Cumulus ID can sign in, and gets the studio but not the staff dashboard or APIs", async () => {
    const r = await signIn(s.base, "stranger");
    assert.equal(r.status, 303);
    const c = r.headers.getSetCookie().find((x) => x.startsWith("conjure_session=")).split(";")[0];
    const home = await fetch(`${s.base}/`, { headers: { cookie: c } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="intent"/, "people land in the studio");
    assert.equal((await fetch(`${s.base}/dashboard`, { headers: { cookie: c } })).status, 403);
    assert.equal((await fetch(`${s.base}/api/admin/overview`, { headers: { cookie: c } })).status, 403);
    assert.equal((await fetch(`${s.base}/v1/health`, { headers: { cookie: c } })).status, 403);
  });

  test("a forged state is refused", async () => {
    const r = await fetch(`${s.base}/auth/cid/callback?code=owner&state=forged`, { redirect: "manual" });
    assert.equal(r.status, 401);
  });

  test("the owner's Cumulus ID sets an HttpOnly, SameSite=Lax session cookie", async () => {
    const r = await signIn(s.base, "owner", { "x-forwarded-proto": "https" });
    assert.equal(r.status, 303);
    const set = r.headers.getSetCookie().find((c) => c.startsWith("conjure_session="));
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.match(set, /Secure/);
    assert.doesNotMatch(set, new RegExp(TOKEN), "the cookie must not contain the raw token");
    cookie = set.split(";")[0];
    assert.equal((await fetch(`${s.base}/`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/history`, { headers: { cookie } })).status, 200);
  });

  test("the account bar learns who is signed in, and a same-origin GET /logout signs out", async () => {
    const r = await signIn(s.base, "owner");
    const jar = r.headers.getSetCookie().filter((c) => /^conjure_(session|who)=/.test(c)).map((c) => c.split(";")[0]).join("; ");
    const me = await (await fetch(`${s.base}/api/me`, { headers: { cookie: jar } })).json();
    assert.deepEqual([me.name, me.username, me.email, me.role], ["William", "william", "william@cumuluscloud.app", "admin"]);
    assert.equal((await fetch(`${s.base}/api/me`)).status, 401);
    const cross = await fetch(`${s.base}/logout`, { redirect: "manual", headers: { cookie: jar, "sec-fetch-site": "cross-site" } });
    assert.notEqual(cross.headers.get("location"), "/login", "another site must not sign people out");
    const out = await fetch(`${s.base}/logout`, { redirect: "manual", headers: { cookie: jar, "sec-fetch-site": "same-origin" } });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/login");
    assert.ok(out.headers.getSetCookie().some((c) => c.startsWith("conjure_session=;")));
    const create = await fetch(`${s.base}/auth/cid/start?prompt=create`, { redirect: "manual" });
    assert.equal(new URL(create.headers.get("location")).searchParams.get("prompt"), "create");
  });

  test("a Bearer token works for scripts", async () => {
    assert.equal((await fetch(`${s.base}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/status`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  });

  test("cross-site and non-JSON POSTs are refused", async () => {
    const cross = await fetch(`${s.base}/api/conjure`, { method: "POST", headers: { cookie, origin: "https://preview.example", ...json }, body: JSON.stringify({ intent: "x", mock: true }) });
    assert.equal(cross.status, 403);
    const plain = await fetch(`${s.base}/api/conjure`, { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: JSON.stringify({ intent: "x", mock: true }) });
    assert.equal(plain.status, 415);
  });

  test("security headers are set and the app cannot be framed", async () => {
    const r = await fetch(`${s.base}/`, { headers: { cookie } });
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });

  test("a build runs, its files preview, and run records stay private", async () => {
    const r = await fetch(`${s.base}/api/conjure`, { method: "POST", headers: { cookie, ...json }, body: JSON.stringify({ intent: "a coin flipper", mock: true }) });
    assert.equal(r.status, 200);
    const events = await readStream(r);
    const done = events.find((e) => e.type === "done");
    assert.ok(done, `no done event: ${JSON.stringify(events.slice(-3))}`);
    assert.equal(done.manifest.verification.ok, true);
    const { previewBase } = await (await fetch(`${s.base}/api/status`, { headers: { cookie } })).json();
    const space = previewBase.split("/").pop();
    assert.match(space, /^k_[0-9a-f]{24}$/);
    assert.equal((await fetch(`${s.preview}/${space}/${done.dir}/index.html`)).status, 200);
    assert.equal((await fetch(`${s.preview}/${done.dir}/index.html`)).status, 404, "builds are only served under their account's space");
    assert.equal((await fetch(`${s.preview}/${space}/${done.dir}/conjure.json`)).status, 404);
    assert.equal((await fetch(`${s.preview}/${space}/${done.dir}/transcript.jsonl`)).status, 404);
    assert.equal((await fetch(`${s.preview}/..%2F..%2Fpackage.json`)).status, 400);
    const zip = await fetch(`${s.base}/api/download?dir=${done.dir}`, { headers: { cookie } });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
  });
});

describe("server without sign-in (local default)", () => {
  let s;
  before(async () => {
    s = await startServer({ CONJURE_MOCK_DELAY: "150" });
  });
  after(() => s.stop());

  test("pages and API are open, and /login does not exist", async () => {
    assert.equal((await fetch(`${s.base}/`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/status`)).status, 200);
    assert.equal((await fetch(`${s.base}/login`)).status, 404);
  });

  test("a run keeps going when its connection drops, and shows as busy until done", async () => {
    const ctrl = new AbortController();
    const r = await fetch(`${s.base}/api/conjure`, { method: "POST", headers: json, body: JSON.stringify({ intent: "a stopwatch", mock: true }), signal: ctrl.signal });
    assert.equal(r.status, 200);
    ctrl.abort(); // the phone locks its screen
    await new Promise((res) => setTimeout(res, 100));
    const busy = await (await fetch(`${s.base}/api/status`)).json();
    assert.equal(busy.busy, true);
    assert.match(busy.job.label, /stopwatch/);
    let st = busy;
    for (let i = 0; i < 100 && st.busy; i++) {
      await new Promise((res) => setTimeout(res, 100));
      st = await (await fetch(`${s.base}/api/status`)).json();
    }
    assert.equal(st.busy, false, "the run should finish on its own");
    const hist = await (await fetch(`${s.base}/api/history`)).json();
    assert.ok(hist.some((h) => h.intent === "a stopwatch" && h.ok), "the finished run is in history");
  });

  test("Stop cancels a run on the server even after its connection dropped", async () => {
    const ctrl = new AbortController();
    await fetch(`${s.base}/api/conjure`, { method: "POST", headers: json, body: JSON.stringify({ intent: "a metronome", mock: true }), signal: ctrl.signal });
    ctrl.abort();
    const c = await (await fetch(`${s.base}/api/cancel`, { method: "POST" })).json();
    assert.equal(c.cancelled, true);
    let st;
    for (let i = 0; i < 50; i++) {
      st = await (await fetch(`${s.base}/api/status`)).json();
      if (!st.busy) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(st.busy, false);
  });

  test("a second run while one is in progress is refused", async () => {
    const ctrl = new AbortController();
    await fetch(`${s.base}/api/conjure`, { method: "POST", headers: json, body: JSON.stringify({ intent: "a timer", mock: true }), signal: ctrl.signal });
    const second = await fetch(`${s.base}/api/conjure`, { method: "POST", headers: json, body: JSON.stringify({ intent: "another", mock: true }) });
    assert.equal(second.status, 409);
    ctrl.abort();
    await fetch(`${s.base}/api/cancel`, { method: "POST" });
  });
});

describe("live only: a server with no model refuses work instead of faking it", () => {
  let s;
  before(async () => {
    s = await startServer({ CONJURE_MOCK: "", CONJURE_LLM_URL: "", CONJURE_OPEN_WEIGHTS_URL: "", CONJURE_OPEN_WEIGHTS_MODEL: "", CONJURE_PROVIDER: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_PROFILE: "" });
  });
  after(() => s?.stop());

  test("status reports no live model", async () => {
    const st = await (await fetch(`${s.base}/api/status`)).json();
    assert.equal(st.live, false);
    assert.equal(st.model, null);
  });

  test("a build is refused with 503, even when the request asks for the mock", async () => {
    const r = await fetch(`${s.base}/api/conjure`, { method: "POST", headers: json, body: JSON.stringify({ intent: "a coin flipper", mock: true, flaw: true }) });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /no live model/);
  });
});
