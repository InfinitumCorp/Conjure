#!/usr/bin/env node
// Local web UI for Conjure. Binds to 127.0.0.1 only.
import http from "node:http";
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
async function runJob(req, res, mock, flaw, job) {
  if (current) return res.writeHead(409).end("a run is already in progress");
  const controller = new AbortController();
  current = { controller };
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return serveFile(res, path.join(PUBLIC, "index.html"));
  }
  if (req.method === "GET" && STATIC.has(url.pathname)) {
    return serveFile(res, path.join(PUBLIC, url.pathname.slice(1)));
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, { live: hasCredentials(), busy: Boolean(current), previewOrigin: `http://localhost:${PREVIEW_PORT}` });
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
        conjure({ intent: payload.intent, provider, outDir: OUT, signal, onEvent }));
    }
    const dir = typeof payload.dir === "string" && !payload.dir.includes("/") && !payload.dir.includes("\\") ? confined(OUT, payload.dir) : null;
    if (!dir) return res.writeHead(400).end("dir must name a deliverable folder");
    if (typeof payload.change !== "string" || !payload.change.trim() || payload.change.length > 4000) {
      return res.writeHead(400).end("change must be a non-empty string under 4000 chars");
    }
    return runJob(req, res, payload.mock, false, (provider, signal, onEvent) =>
      refine({ dir, change: payload.change, provider, signal, onEvent }));
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
  const name = path.basename(rel);
  if (name === "transcript.jsonl") return res.writeHead(404).end("not found");
  const file = confined(OUT, rel);
  if (!file) return res.writeHead(400).end("bad path");
  return serveFile(res, file);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✦ Conjure UI on http://localhost:${PORT}  (${hasCredentials() ? "live: Claude" : "offline: mock provider"})`);
});
preview.listen(PREVIEW_PORT, "127.0.0.1", () => console.log(`  previews on http://localhost:${PREVIEW_PORT}`));
