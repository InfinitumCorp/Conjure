// Integration tests for the web server: sign-in, request checks, headers, previews
// and runs that outlive their connection. Each suite starts a real server process.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

describe("server with sign-in (CONJURE_ACCESS_TOKEN set)", () => {
  let s;
  let cookie;
  before(async () => {
    s = await startServer({ CONJURE_ACCESS_TOKEN: TOKEN });
  });
  after(() => s.stop());

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

  test("a wrong token is refused", async () => {
    const r = await fetch(`${s.base}/login`, { method: "POST", body: new URLSearchParams({ token: "nope" }), redirect: "manual" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("set-cookie"), null);
  });

  test("a login POST from another site is refused even with the right token", async () => {
    const r = await fetch(`${s.base}/login`, { method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams({ token: TOKEN }), redirect: "manual" });
    assert.equal(r.status, 403);
  });

  test("the right token sets an HttpOnly, SameSite=Strict session cookie", async () => {
    const r = await fetch(`${s.base}/login`, { method: "POST", headers: { "x-forwarded-proto": "https" }, body: new URLSearchParams({ token: TOKEN }), redirect: "manual" });
    assert.equal(r.status, 303);
    const set = r.headers.get("set-cookie");
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Secure/);
    assert.doesNotMatch(set, new RegExp(TOKEN), "the cookie must not contain the raw token");
    cookie = set.split(";")[0];
    assert.equal((await fetch(`${s.base}/`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/history`, { headers: { cookie } })).status, 200);
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
    assert.equal((await fetch(`${s.preview}/${done.dir}/index.html`)).status, 200);
    assert.equal((await fetch(`${s.preview}/${done.dir}/conjure.json`)).status, 404);
    assert.equal((await fetch(`${s.preview}/${done.dir}/transcript.jsonl`)).status, 404);
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
