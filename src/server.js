#!/usr/bin/env node
// Web UI for Conjure. Binds to 127.0.0.1 by default (HOST to change). When
// CONJURE_ACCESS_TOKEN is set (cloud deploys), every page and API call needs a login.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { conjure, refine, ConjureError, ConjureCancelled } from "./engine.js";
import { makeProvider, hasCredentials, DEFAULT_OUT } from "./config.js";
import { zipDeliverable } from "./zip.js";

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
const ABORT_ON_DISCONNECT = process.env.CONJURE_ABORT_ON_DISCONNECT === "1";
const MOCK_DELAY = Number(process.env.CONJURE_MOCK_DELAY || 0);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const STATIC = new Set(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);

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

// --- Access control (only when CONJURE_ACCESS_TOKEN is set) ---
const COOKIE = "conjure_session";
const sessionValue = ACCESS_TOKEN ? crypto.createHmac("sha256", ACCESS_TOKEN).update("conjure-session-v1").digest("hex") : "";

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  if (bearer && safeEqual(bearer, ACCESS_TOKEN)) return true;
  return safeEqual(cookies(req)[COOKIE] || "", sessionValue);
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
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:5px}
footer{padding:22px clamp(16px,4vw,48px);border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
footer .tm{font-size:.65em}</style></head><body>
<main><form method="post" action="/login"><h1>Conjure<sup class="tm">™</sup></h1>
<p>Sign in with the access token for this server.</p>
${error ? `<p class="err" role="alert">${error}</p>` : ""}
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
<button>Sign in</button></form></main>
<footer>Conjure<sup class="tm">™</sup> · Infinitum Corporation</footer></body></html>`;

async function handleLogin(req, res) {
  if (req.method === "GET") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LOGIN_PAGE(""));
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return res.writeHead(413).end();
  }
  const token = new URLSearchParams(body).get("token") || "";
  if (!safeEqual(token, ACCESS_TOKEN)) {
    await new Promise((r) => setTimeout(r, 750)); // slow down guessing
    return res.writeHead(401, { "content-type": "text/html; charset=utf-8" }).end(LOGIN_PAGE("That token is not right."));
  }
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, {
    location: "/",
    "set-cookie": `${COOKIE}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
  });
  res.end();
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
async function runJob(req, res, mock, flaw, job, label) {
  if (current) return res.writeHead(409).end("a run is already in progress");
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
  const provider = makeProvider({ mock: mock ? true : undefined, flaw: Boolean(flaw), delayMs: MOCK_DELAY });
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
  if (ACCESS_TOKEN && url.pathname === "/login" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST" && !sameOrigin(req)) return res.writeHead(403).end("cross-site request refused");
    return handleLogin(req, res);
  }
  if (!authorized(req)) {
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return res.writeHead(303, { location: "/login" }).end();
    return json(res, 401, { error: "sign in required" });
  }
  if (req.method === "POST") {
    if (!sameOrigin(req)) return res.writeHead(403).end("cross-site request refused");
    if (url.pathname !== "/api/cancel" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      return res.writeHead(415).end("content-type must be application/json");
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return serveFile(res, path.join(PUBLIC, "index.html"));
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, {
      live: hasCredentials(), busy: Boolean(current), previewOrigin: PREVIEW_ORIGIN,
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
      return runJob(req, res, payload.mock, payload.flaw, (provider, signal, onEvent) =>
        conjure({ intent: payload.intent, provider, outDir: OUT, signal, onEvent }), payload.intent.slice(0, 120));
    }
    const dir = typeof payload.dir === "string" && !payload.dir.includes("/") && !payload.dir.includes("\\") ? confined(OUT, payload.dir) : null;
    if (!dir) return res.writeHead(400).end("dir must name a deliverable folder");
    if (typeof payload.change !== "string" || !payload.change.trim() || payload.change.length > 4000) {
      return res.writeHead(400).end("change must be a non-empty string under 4000 chars");
    }
    return runJob(req, res, payload.mock, false, (provider, signal, onEvent) =>
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
  const mode = hasCredentials() ? "live: Claude" : "offline: mock provider";
  console.log(`✦ Conjure UI on http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}  (${mode}${ACCESS_TOKEN ? ", sign-in required" : ""})`);
});
preview.listen(PREVIEW_PORT, HOST, () => console.log(`  previews on ${PREVIEW_ORIGIN}`));
