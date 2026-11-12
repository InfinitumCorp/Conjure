#!/usr/bin/env node
// Web UI for Conjure. Binds to 127.0.0.1 by default (HOST to change). When
// CONJURE_ACCESS_TOKEN is set (cloud deploys), every page and API call needs a login.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { conjure, refine, ConjureError, ConjureCancelled } from "./engine.js";
import { makeProvider, liveModelConfigured, mockMode, DEFAULT_OUT } from "./config.js";
import { zipDeliverable } from "./zip.js";
import { cidConfig, startSignIn, finishSignIn, clearPending } from "./cid.js";
import { AccessStore, KNOWN_PRODUCTS } from "./access.js";
import { PredictionService, publicView } from "./predict/service.js";
import { SearchService } from "./search/index.js";
import { modelUsage } from "./predict/openai.js";
import { GuessGuard, clientIp } from "./guard.js";
import { ConjureError as PredictError } from "./predict/vendor/conjure.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, "..", "public");
const OUT = DEFAULT_OUT;
const PORT = Number(process.env.PORT || 4317);
// Conjured output is served from a separate port (a different origin), so
// generated code can't reach the Conjure API with same-origin access.
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || PORT + 1);
const HOST = process.env.HOST || "127.0.0.1";
// Public URL of the preview server when it sits behind a proxy (e.g. https://preview.example.com).
const PREVIEW_ORIGIN = process.env.PREVIEW_ORIGIN || `http://localhost:${PREVIEW_PORT}`;
const ACCESS_TOKEN = process.env.CONJURE_ACCESS_TOKEN || "";
// People sign in with Cumulus ID. CID_ISSUER can point at a mirror that loads in Russia.
const CID = cidConfig(process.env, { clientId: "conjure" });
const PUBLIC_URL = (process.env.CONJURE_PUBLIC_URL || "").replace(/\/+$/, "");
const ABORT_ON_DISCONNECT = process.env.CONJURE_ABORT_ON_DISCONNECT === "1";
const MOCK_DELAY = Number(process.env.CONJURE_MOCK_DELAY || 0);
// Staff, product keys, predictions and usage. Kept outside OUT: the preview server serves OUT.
const DATA = path.resolve(process.env.CONJURE_DATA || "conjure-data");
const access = await new AccessStore({ file: path.join(DATA, "access.json"), ownerToken: ACCESS_TOKEN }).load();
const guesses = new GuessGuard();
// Conjure Search: answers from the live web with citations (Yandex Search API, in Russia).
const search = new SearchService();
const predictions = new PredictionService({
  dir: path.join(DATA, "predictions"),
  research: search.configured ? (question, o) => search.brief(question, o) : undefined,
  delayMs: MOCK_DELAY,
  onFinish: (rec) => access.logUsage({ kind: "prediction", id: rec.id, product: rec.product, user: rec.user, status: rec.status, ms: rec.ms, calls: rec.sim?.calls ?? 0, mode: rec.mode }),
});
await predictions.load();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const STATIC = new Set(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
  // Interface language (@infinitum/i18n): runtime and build-time catalogs, public, no model calls.
  "/i18n/i18n.js", "/i18n/i18n.css", "/i18n/start.js", "/i18n/catalogs.js"]);

let current = null; // { controller } while a run is in progress

function confined(root, rel) {
  const target = path.resolve(root, rel);
  const r = path.relative(root, target);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? target : null;
}

async function serveFile(res, file) {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function readJson(req, limit = 16 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return JSON.parse(body);
}

// --- Access control (only when CONJURE_ACCESS_TOKEN is set; otherwise local and open) ---
const COOKIE = "conjure_session";

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {}
    }
  }
  return out;
}

/** The owner (owner token or session cookie), a product (product key), or null. */
function principal(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1]?.trim();
  if (bearer) return access.staffByToken(bearer) || access.productByKey(bearer);
  if (!access.enabled) return { kind: "staff", id: "local", name: "Local", role: "admin" };
  return access.staffBySession(cookies(req)[COOKIE]);
}

/** Rejects cross-site writes: browsers send Origin on POST, and it must match this host. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, the CLI) send none
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const LOGIN_PAGE = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Conjure · Sign in</title>
<meta name="theme-color" content="#ffffff"><link rel="icon" type="image/png" href="/icon-192.png">
<style>:root{--paper:#fff;--ink:#111820;--muted:#52606b;--line:#d6dce1;--accent:#2454dd;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55}
main{flex:1;display:flex;align-items:center;padding:48px clamp(16px,4vw,48px)}
form{width:min(520px,100%);display:grid;gap:18px}
h1{font-weight:400;margin:0;font-size:clamp(56px,9vw,112px);line-height:.98;letter-spacing:-.065em}
sup.tm{font-size:.38em;vertical-align:super;line-height:0;margin-left:.08em;letter-spacing:0;font-weight:400}
p{margin:0;color:var(--muted)}.err{color:var(--ink);font-weight:700}
label{font-size:13px;color:var(--muted)}
input{width:100%;padding:16px;border:1px solid var(--ink);border-radius:0;background:var(--paper);color:var(--ink);font:inherit;font-size:18px}
input:focus{outline:none;border-color:var(--accent)}
button{justify-self:start;padding:17px 22px;border:1px solid var(--ink);border-radius:0;background:var(--ink);color:#fff;font:inherit;cursor:pointer;transition:background .2s,border-color .2s}
button:hover{background:var(--accent);border-color:var(--accent)}
button.link{padding:0;border:0;background:none;color:var(--ink);text-decoration:underline;text-underline-offset:3px}
button.link:hover{background:none;color:var(--accent)}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:5px}
footer{padding:22px clamp(16px,4vw,48px);border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
footer .tm{font-size:.65em}</style></head><body>
<main><form method="get" action="/auth/cid/start"><h1>Conjure<sup class="tm">™</sup></h1>
<p>Private to Infinitum staff. Sign in with your Cumulus ID.</p>
${error ? `<p class="err" role="alert">${error}</p>` : ""}
<button autofocus>Sign in with Cumulus ID</button>
<p>No Cumulus ID yet? <button class="link" name="create" value="1">Create a Cumulus ID</button></p></form></main>
<footer>Conjure<sup class="tm">™</sup> · Infinitum Corporation</footer></body></html>`;

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isSecure = (req) => (PUBLIC_URL ? PUBLIC_URL.startsWith("https://") : req.headers["x-forwarded-proto"] === "https");
// Other hostnames that forward to this server (Conjure Russia's global hostname, a Cloudflare Worker).
// A request that arrived through one of them is sent back to it after sign-in, so the sign-in cookie
// it set is there to read. Only listed names count: X-Forwarded-Host is otherwise ignored.
const FRONT_HOSTS = new Set((process.env.CONJURE_FRONT_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
export const publicHost = (req) => {
  const fwd = String(req.headers["x-forwarded-host"] || "").trim().toLowerCase();
  return fwd && FRONT_HOSTS.has(fwd) ? fwd : req.headers.host;
};
const redirectUri = (req) =>
  publicHost(req) !== req.headers.host
    ? `https://${publicHost(req)}/auth/cid/callback`
    : `${PUBLIC_URL || `${isSecure(req) ? "https" : "http"}://${req.headers.host}`}/auth/cid/callback`;
const loginPage = (res, status, error) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(LOGIN_PAGE(error ? esc(error) : ""));

/** GET /login, /auth/cid/start and /auth/cid/callback: sign in with Cumulus ID. */
async function handleLogin(req, res, url) {
  const secure = isSecure(req);
  if (url.pathname === "/login") return req.method === "GET" ? loginPage(res, 200, "") : res.writeHead(405, { allow: "GET" }).end();
  if (req.method !== "GET") return res.writeHead(405, { allow: "GET" }).end();
  if (url.pathname === "/auth/cid/start") {
    const go = startSignIn({ ...CID, redirectUri: redirectUri(req), secret: access.secret, create: url.searchParams.get("create") === "1", secure });
    return res.writeHead(302, { location: go.location, "set-cookie": go.cookie }).end();
  }
  let who;
  try {
    const { profile } = await finishSignIn({ ...CID, redirectUri: redirectUri(req), secret: access.secret, query: url.searchParams, cookies: cookies(req) });
    who = await access.staffByCid(profile, CID.owners);
    if (!who) {
      res.setHeader("set-cookie", clearPending(secure));
      return loginPage(res, 403, "This Cumulus ID is not a Conjure owner (CID_OWNERS).");
    }
  } catch (e) {
    res.setHeader("set-cookie", clearPending(secure));
    return loginPage(res, 401, e.message);
  }
  const s = secure ? "; Secure" : "";
  // Lax, not Strict: the browser arrives here from the Cumulus ID redirect.
  res.writeHead(303, {
    location: "/",
    "set-cookie": [`${COOKIE}=${access.sessionFor(who)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${s}`, clearPending(secure)],
  });
  res.end();
}

function logout(req, res) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, { location: "/login", "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}` }).end();
}

const json = (res, status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));

async function history() {
  const out = [];
  let dirs = [];
  try {
    dirs = await fs.readdir(OUT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const m = JSON.parse(await fs.readFile(path.join(OUT, d.name, "conjure.json"), "utf8"));
      const last = m.history?.at(-1);
      out.push({
        dir: d.name, name: m.plan?.name, intent: m.intent, ok: m.verification?.ok, files: m.files,
        createdAt: m.createdAt, updatedAt: last?.at ?? m.createdAt, provider: m.provider, costUsd: m.costUsd,
        changes: (m.history ?? []).map((h) => h.change),
      });
    } catch {}
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function friendly(err) {
  if (err instanceof ConjureCancelled) return null;
  if (err instanceof Anthropic.AuthenticationError) return "Authentication failed - check ANTHROPIC_API_KEY in .env, or use offline mode.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API - try again shortly.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  if (err instanceof ConjureError) return err.message;
  console.error(err);
  return "unexpected error";
}

/** Streams a run's events as server-sent events; aborts the run if the client disconnects. */
async function runJob(req, res, job, label) {
  if (current) return res.writeHead(409).end("a run is already in progress");
  // Live only: no model, no run (never a demo build).
  if (!liveModelConfigured() && !mockMode()) return res.writeHead(503).end("no live model is configured on this server");
  const controller = new AbortController();
  current = { controller, label, startedAt: new Date().toISOString() };
  let finished = false;
  // A dropped connection (phone screen locked, tab closed) does not cancel the run by default:
  // the result lands in history, and Stop / POST /api/cancel still cancels it.
  res.on("close", () => {
    if (!finished && ABORT_ON_DISCONNECT) controller.abort();
  });

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (e) => !res.writableEnded && res.write(`data: ${JSON.stringify(e)}\n\n`);
  const provider = makeProvider({ delayMs: MOCK_DELAY });
  send({ type: "start", provider: provider.name, model: provider.model });

  const onEvent = (e) => {
    if (e.type === "error") return; // reported below with a friendly message
    if (e.type === "done") send({ type: "done", manifest: e.manifest, refinement: e.refinement, dir: path.basename(e.workspace) });
    else if (e.workspace) send({ ...e, workspace: path.basename(e.workspace) });
    else send(e);
  };
  try {
    await job(provider, controller.signal, onEvent);
  } catch (err) {
    const message = friendly(err);
    if (message) send({ type: "error", message });
  } finally {
    finished = true;
    current = null;
    res.end();
  }
}

/* ---------------- /v1: the @conjure prediction API for products ---------------- */

const DAY = 864e5;
const recentFor = (product, ms = DAY) => predictions.list({ product }).filter((r) => Date.now() - Date.parse(r.createdAt) < ms);

/** Streams a prediction's updates (server-sent events) until it finishes. */
function streamPrediction(req, res, rec, full) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (v) => !res.writableEnded && res.write(`data: ${JSON.stringify(v)}\n\n`);
  const done = (s) => s === "done" || s === "failed" || s === "cancelled";
  send(publicView(rec, { full }));
  if (done(rec.status)) return res.end();
  const onUpdate = () => {
    send(publicView(rec, { full }));
    if (done(rec.status)) finish();
  };
  const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15000);
  const finish = () => {
    clearInterval(ping);
    predictions.off(`update:${rec.id}`, onUpdate);
    res.end();
  };
  predictions.on(`update:${rec.id}`, onUpdate);
  req.on("close", finish);
}

// Searches per product per day (UTC), kept in memory: a restart resets the count.
const SEARCH_DAILY_LIMIT = Math.max(1, Number(process.env.CONJURE_SEARCH_DAILY_LIMIT) || 1000);
const searchCounts = new Map();
function countSearch(product) {
  const day = new Date().toISOString().slice(0, 10);
  for (const k of searchCounts.keys()) if (!k.startsWith(day)) searchCounts.delete(k);
  const key = `${day}:${product}`;
  const n = (searchCounts.get(key) ?? 0) + 1;
  searchCounts.set(key, n);
  return n;
}

/** POST /v1/search {query, fresh?}: a cited answer from the web. Streams progress with ?stream=1 or Accept: text/event-stream. */
async function handleSearch(req, res, url, who, product) {
  let body;
  try {
    body = await readJson(req, 16 * 1024);
  } catch {
    return json(res, 400, { error: "invalid JSON" });
  }
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (query.length < 3 || query.length > 1000) return json(res, 400, { error: "query must be 3 to 1000 characters" });
  if (!search.configured) return json(res, 503, { error: "Web search isn't switched on for this server." });
  if (who.kind === "product" && countSearch(product) > SEARCH_DAILY_LIMIT) return json(res, 429, { error: `daily limit of ${SEARCH_DAILY_LIMIT} searches reached for ${product}` });
  if (who.kind === "product") access.touchProduct(who.record);
  const started = Date.now();
  const user = typeof body.user === "string" ? body.user.slice(0, 120) : undefined;
  const log = (status) => access.logUsage({ kind: "search", product, user, status, ms: Date.now() - started });
  const controller = new AbortController();
  const fresh = Boolean(body.fresh);
  const streaming = url.searchParams.get("stream") === "1" || /text\/event-stream/.test(req.headers.accept || "");
  if (!streaming) {
    res.on("close", () => !res.writableEnded && controller.abort());
    try {
      const r = await search.ask(query, { signal: controller.signal, fresh });
      log("done");
      return json(res, 200, r);
    } catch (err) {
      log("failed");
      return json(res, err.status || 502, { error: err.message });
    }
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (v) => !res.writableEnded && res.write(`data: ${JSON.stringify(v)}\n\n`);
  const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15000);
  res.on("close", () => controller.abort());
  try {
    await search.ask(query, { onEvent: send, signal: controller.signal, fresh });
    log("done");
  } catch (err) {
    log("failed");
    send({ type: "error", message: controller.signal.aborted ? "cancelled" : err.message });
  } finally {
    clearInterval(ping);
    send({ type: "end" });
    res.end();
  }
}

async function handleV1(req, res, url, who) {
  // Staff calling /v1 directly (from the dashboard console or curl) act as the "dashboard" product.
  const product = who.kind === "product" ? who.slug : "dashboard";
  const own = (rec) => rec && (who.kind === "staff" || rec.product === product);
  const m = /^\/v1\/predictions(?:\/([\w-]+))?(?:\/(events|interview|cancel))?$/.exec(url.pathname);

  if (req.method === "GET" && url.pathname === "/v1/health") {
    // Live on open-weight models (CONJURE_LLM_URL) as well as on Claude, the same test as the dashboard's.
    const live = liveModelConfigured() && !mockMode();
    return json(res, 200, { ok: true, product, live, search: search.configured, ...predictions.stats() });
  }
  if (req.method === "POST" && url.pathname === "/v1/search") return handleSearch(req, res, url, who, product);
  if (!m) return json(res, 404, { error: "not found" });
  const [, id, action] = m;

  if (!id && req.method === "GET") return json(res, 200, predictions.list({ product: who.kind === "product" ? product : undefined }).slice(0, 100).map((r) => publicView(r)));
  if (!id && req.method === "POST") {
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
    if (who.kind === "product" && recentFor(product).length >= (who.dailyLimit ?? 500)) {
      return json(res, 429, { error: `daily limit of ${who.dailyLimit} forecasts reached for ${product}` });
    }
    try {
      // Live only: a caller can't ask for a demo forecast.
      const rec = await predictions.create({ ...body, product, user: body.user, mock: false });
      if (who.kind === "product") access.touchProduct(who.record);
      return json(res, 202, publicView(rec));
    } catch (err) {
      if (err instanceof PredictError) return json(res, 400, { error: err.message });
      throw err;
    }
  }

  const rec = predictions.get(id);
  if (!own(rec)) return json(res, 404, { error: "no such prediction" });
  if (req.method === "GET" && !action) return json(res, 200, publicView(rec, { full: url.searchParams.get("full") === "1" }));
  if (req.method === "GET" && action === "events") return streamPrediction(req, res, rec, url.searchParams.get("full") === "1");
  if (req.method === "POST" && action === "cancel") return json(res, 200, { cancelled: predictions.cancel(rec) });
  if (req.method === "POST" && action === "interview") {
    try {
      const body = await readJson(req);
      return json(res, 200, { answer: await predictions.ask(rec, body.agentId, body.question) });
    } catch (err) {
      if (err instanceof PredictError) return json(res, 400, { error: err.message });
      if (err instanceof SyntaxError) return json(res, 400, { error: "invalid JSON" });
      throw err;
    }
  }
  return json(res, 405, { error: "method not allowed" });
}

/* ---------------- /api/admin: the staff dashboard ---------------- */

function summarize(list) {
  const finished = list.filter((r) => r.status === "done" || r.status === "failed");
  const ok = finished.filter((r) => r.status === "done").length;
  return {
    total: list.length, done: ok, failed: finished.length - ok,
    successRate: finished.length ? Math.round((ok / finished.length) * 100) / 100 : null,
    avgMs: finished.length ? Math.round(finished.reduce((s, r) => s + (r.ms || 0), 0) / finished.length) : null,
    calls: list.reduce((s, r) => s + (r.sim?.calls || 0), 0),
  };
}

async function handleAdmin(req, res, url, who) {
  const admin = who.role === "admin";
  const write = req.method === "POST";
  if (write && !admin) return json(res, 403, { error: "admins only" });
  let body = {};
  if (write) {
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
  }
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/api/admin/overview") {
      const all = predictions.list();
      const last24 = all.filter((r) => Date.now() - Date.parse(r.createdAt) < DAY);
      const products = access.listProducts().map((k) => ({ ...k, day: summarize(recentFor(k.slug)), week: summarize(recentFor(k.slug, 7 * DAY)) }));
      return json(res, 200, {
        me: { name: who.name, role: who.role },
        live: liveModelConfigured() && !mockMode(),
        model: process.env.CONJURE_LLM_URL
          ? process.env.CONJURE_LLM_MODEL || "qwen2.5:3b"
          : process.env.CONJURE_PREDICT_MODEL || process.env.CONJURE_MODEL || "claude-opus-5-5",
        allowance: await modelUsage(),
        queue: predictions.stats(), builderBusy: Boolean(current),
        day: summarize(last24), week: summarize(all.filter((r) => Date.now() - Date.parse(r.createdAt) < 7 * DAY)),
        products, known: KNOWN_PRODUCTS, search: search.configured,
        recent: all.slice(0, 50).map((r) => publicView(r)),
      });
    }
    if (req.method === "GET" && p.startsWith("/api/admin/predictions/")) {
      const rec = predictions.get(p.split("/").pop());
      return rec ? json(res, 200, publicView(rec, { full: true })) : json(res, 404, { error: "no such prediction" });
    }
    if (write && p === "/api/admin/products") return json(res, 201, await access.addProduct(body, who));
    let mm = /^\/api\/admin\/products\/([\w-]+)\/(rotate|revoke)$/.exec(p);
    if (write && mm) {
      if (mm[2] === "rotate") return json(res, 201, await access.rotateProduct(mm[1], who));
      return json(res, 200, { revoked: await access.revokeProduct(mm[1], who) });
    }
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
  return json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  if (url.pathname.startsWith("/api/")) res.setHeader("cache-control", "no-store");

  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (req.method === "GET" && STATIC.has(url.pathname)) {
    return serveFile(res, path.join(PUBLIC, url.pathname.slice(1)));
  }
  if (ACCESS_TOKEN && (url.pathname === "/login" || url.pathname === "/auth/cid/start" || url.pathname === "/auth/cid/callback")) {
    return handleLogin(req, res, url);
  }
  // Wrong tokens, product keys or session cookies count against the sender's address;
  // too many and it's refused for a while, so credentials can't be guessed.
  const ip = clientIp(req);
  const presented = /^Bearer\s+\S/i.test(req.headers.authorization || "") || Boolean(cookies(req)[COOKIE]);
  const wait = presented ? guesses.retryAfter(ip) : 0;
  if (wait) return res.writeHead(429, { "content-type": "application/json", "retry-after": String(wait) }).end(JSON.stringify({ error: "too many wrong credentials; try again later" }));
  const who = principal(req);
  if (presented && access.enabled) who ? guesses.succeed(ip) : guesses.fail(ip);
  const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/");
  if (!who) {
    if (req.method === "GET" && !isApi) return res.writeHead(303, { location: "/login" }).end();
    return json(res, 401, { error: "sign in required" });
  }
  if (req.method === "POST") {
    if (!sameOrigin(req)) return res.writeHead(403).end("cross-site request refused");
    if (url.pathname !== "/api/cancel" && url.pathname !== "/logout" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      return res.writeHead(415).end("content-type must be application/json");
    }
  }
  if (url.pathname.startsWith("/v1/")) return handleV1(req, res, url, who);
  // Product keys reach only the /v1 API; the dashboard and studio are for staff.
  if (who.kind !== "staff") return json(res, 403, { error: "product keys can only call /v1" });
  if (url.pathname === "/logout" && req.method === "POST") return logout(req, res);
  if (url.pathname.startsWith("/api/admin/")) return handleAdmin(req, res, url, who);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
    return serveFile(res, path.join(PUBLIC, "dashboard.html"));
  }
  if (req.method === "GET" && (url.pathname === "/studio" || url.pathname === "/index.html")) {
    return serveFile(res, path.join(PUBLIC, "index.html"));
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, {
      live: liveModelConfigured() && !mockMode(), model: liveModelConfigured() && !mockMode() ? makeProvider().model : null, busy: Boolean(current), previewOrigin: PREVIEW_ORIGIN,
      job: current ? { label: current.label, startedAt: current.startedAt } : null,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/history") {
    return json(res, 200, await history());
  }
  if (req.method === "GET" && url.pathname === "/api/download") {
    const name = url.searchParams.get("dir") ?? "";
    const dir = name && !/[\\/]/.test(name) ? confined(OUT, name) : null;
    if (!dir) return res.writeHead(400).end("dir must name a deliverable folder");
    try {
      await fs.access(path.join(dir, "conjure.json"));
    } catch {
      return res.writeHead(404).end("not a deliverable");
    }
    const z = await zipDeliverable(dir);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": z.buffer.length,
      "content-disposition": `attachment; filename="${z.name.replace(/[^\w.-]/g, "_")}"`,
    });
    return res.end(z.buffer);
  }
  if (req.method === "POST" && url.pathname === "/api/cancel") {
    if (!current) return json(res, 200, { cancelled: false });
    current.controller.abort();
    return json(res, 200, { cancelled: true });
  }
  if (req.method === "POST" && (url.pathname === "/api/conjure" || url.pathname === "/api/refine")) {
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      return res.writeHead(400).end("invalid JSON");
    }
    if (url.pathname === "/api/conjure") {
      if (typeof payload.intent !== "string" || !payload.intent.trim() || payload.intent.length > 4000) {
        return res.writeHead(400).end("intent must be a non-empty string under 4000 chars");
      }
      return runJob(req, res, (provider, signal, onEvent) =>
        conjure({ intent: payload.intent, provider, outDir: OUT, signal, onEvent }), payload.intent.slice(0, 120));
    }
    const dir = typeof payload.dir === "string" && !payload.dir.includes("/") && !payload.dir.includes("\\") ? confined(OUT, payload.dir) : null;
    if (!dir) return res.writeHead(400).end("dir must name a deliverable folder");
    if (typeof payload.change !== "string" || !payload.change.trim() || payload.change.length > 4000) {
      return res.writeHead(400).end("change must be a non-empty string under 4000 chars");
    }
    return runJob(req, res, (provider, signal, onEvent) =>
      refine({ dir, change: payload.change, provider, signal, onEvent }), `refine ${payload.dir}: ${payload.change.slice(0, 100)}`);
  }
  res.writeHead(404).end("not found");
});

const preview = http.createServer(async (req, res) => {
  if (req.method !== "GET") return res.writeHead(405).end();
  const url = new URL(req.url, "http://localhost");
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return res.writeHead(400).end("bad path");
  }
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  // Run records stay private: only the deliverable's own files are served.
  const parts = rel.split("/");
  if (parts.length === 2 && (parts[1] === "transcript.jsonl" || parts[1] === "conjure.json")) return res.writeHead(404).end("not found");
  if (path.basename(rel) === "transcript.jsonl") return res.writeHead(404).end("not found");
  const file = confined(OUT, rel);
  if (!file) return res.writeHead(400).end("bad path");
  return serveFile(res, file);
});

server.listen(PORT, HOST, () => {
  const mode = mockMode() ? "test mode: scripted mock" : liveModelConfigured() ? `live: ${makeProvider().model}` : "NO LIVE MODEL: builds and forecasts are refused";
  console.log(`✦ Conjure UI on http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}  (${mode}${ACCESS_TOKEN ? ", sign-in required" : ""})`);
});
preview.listen(PREVIEW_PORT, HOST, () => console.log(`  previews on ${PREVIEW_ORIGIN}`));
