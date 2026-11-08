// Conjure™ client for Infinitum products. Zero dependencies: Node 18+, Workers, Deno, Bun.
//
// Anyone can type "@conjure <question>" in a product. The product passes that text here
// (server side: the product key must never reach a browser) and gets back a live
// prediction: a swarm of AI agents plays the question out and a report agent forecasts it.
//
//   import { createConjure } from "./conjure.mjs";
//   const conjure = createConjure({ url: process.env.CONJURE_URL, key: process.env.CONJURE_PRODUCT_KEY });
//   const result = await conjure.handleMention(message.text, { context: dealNotes, user: userId });
//   if (result) reply(result.text);           // null when the text has no @conjure
//
// Source of truth: InfinitumCorp/Conjure client/conjure.mjs. Copies in products are synced from it.

export const CONJURE_CLIENT_VERSION = "1.0.0";

export class ConjureApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ConjureApiError";
    this.status = status;
    this.body = body;
  }
}

// "@conjure" as a word: not part of an email (a@conjure.com) or a longer handle (@conjured).
const MENTION = /(^|[^\w@./])@conjure(?![\w-]|\.[a-z])/i;

/**
 * Finds an @conjure mention. The question is the text after it, or the text before it when
 * nothing follows ("Will we close Acme by March? @conjure"). Returns null when there's none.
 */
export function parseConjureMention(text) {
  if (typeof text !== "string") return null;
  const m = MENTION.exec(text);
  if (!m) return null;
  const at = m.index + m[1].length;
  const after = text.slice(at + "@conjure".length).replace(/^[\s:,\-–—]+/, "").trim();
  const before = text.slice(0, at).trim();
  const question = (after || before).replace(/\s+/g, " ").slice(0, 500);
  if (!question) return { question: "", context: "" };
  return { question, context: after && before ? before.slice(0, 30000) : "" };
}

export function hasConjureMention(text) {
  return parseConjureMention(text) !== null;
}

/** Plain-text reply a product can post back into the thread, chat or record. */
export function formatForecast(prediction) {
  const r = prediction?.report;
  if (!r) {
    if (prediction?.status === "failed") return `Conjure™ couldn't finish this forecast: ${prediction.error || "unknown error"}.`;
    return `Conjure™ is forecasting "${prediction?.question ?? ""}" (round ${prediction?.round ?? 0} of ${prediction?.rounds ?? "?"}).`;
  }
  const pct = Math.round(r.probability * 100);
  const lines = [
    `Conjure™ forecast: ${r.outcome}`,
    `${pct}% likely that ${prediction.poles?.for || "it happens"} (${r.confidence} confidence, ${prediction.agents} agents over ${prediction.rounds} rounds).`,
  ];
  if (r.drivers?.length) lines.push(`Drivers: ${r.drivers.slice(0, 3).join("; ")}.`);
  if (r.signals?.length) lines.push(`Watch: ${r.signals.slice(0, 3).join("; ")}.`);
  lines.push("A simulation is evidence, not proof.");
  return lines.join("\n");
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
});

/**
 * @param {{ url: string, key: string, fetch?: typeof fetch, timeoutMs?: number, pollMs?: number }} options
 */
export function createConjure({ url, key, fetch: fetchImpl = globalThis.fetch, timeoutMs = 300_000, pollMs = 1500 } = {}) {
  if (!url) throw new Error("createConjure: url is required (CONJURE_URL)");
  if (!key) throw new Error("createConjure: key is required (CONJURE_PRODUCT_KEY)");
  const base = String(url).replace(/\/+$/, "");

  async function call(method, path, body, signal) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) throw new ConjureApiError(data?.error || `Conjure API ${res.status}`, res.status, data);
    return data;
  }

  const api = {
    health: (signal) => call("GET", "/v1/health", undefined, signal),

    /** Starts a prediction and returns at once: { id, status, ... }. */
    start: ({ question, context, user, agents, rounds, source } = {}, signal) =>
      call("POST", "/v1/predictions", { question, context, user, agents, rounds, source }, signal),

    get: (id, signal) => call("GET", `/v1/predictions/${encodeURIComponent(id)}`, undefined, signal),

    list: (signal) => call("GET", "/v1/predictions", undefined, signal),

    interview: (id, agentId, question, signal) =>
      call("POST", `/v1/predictions/${encodeURIComponent(id)}/interview`, { agentId, question }, signal),

    cancel: (id, signal) => call("POST", `/v1/predictions/${encodeURIComponent(id)}/cancel`, {}, signal),

    /** Polls until the prediction finishes. onProgress gets each new state (live round updates). */
    async wait(id, { onProgress, signal, timeoutMs: limit = timeoutMs } = {}) {
      const until = Date.now() + limit;
      let last = "";
      for (;;) {
        const p = await api.get(id, signal);
        const mark = `${p.status}:${p.round}`;
        if (mark !== last) { last = mark; onProgress?.(p); }
        if (p.status === "done" || p.status === "failed" || p.status === "cancelled") return p;
        if (Date.now() > until) throw new ConjureApiError("Timed out waiting for the forecast", 504, p);
        await sleep(pollMs, signal);
      }
    },

    /** Runs a prediction to the end. */
    async predict(question, { context, user, agents, rounds, source, onProgress, signal, timeoutMs: limit } = {}) {
      const started = await api.start({ question, context, user, agents, rounds, source }, signal);
      return api.wait(started.id, { onProgress, signal, timeoutMs: limit });
    },

    /**
     * The one call products make for "@conjure". Returns null when the text has no mention;
     * otherwise { prediction, text } where text is a ready-to-post reply.
     * Set wait: false to get the started prediction back immediately and poll yourself.
     */
    async handleMention(text, { context = "", user, source, agents, rounds, wait = true, onProgress, signal } = {}) {
      const m = parseConjureMention(text);
      if (!m) return null;
      if (!m.question) return { prediction: null, text: "Ask Conjure™ a question after @conjure, for example: @conjure will the Acme deal close this quarter?" };
      const ctx = [m.context, context].filter(Boolean).join("\n\n").slice(0, 30000);
      const opts = { question: m.question, context: ctx, user, source, agents, rounds };
      const prediction = wait ? await api.predict(m.question, { ...opts, onProgress, signal }) : await api.start(opts, signal);
      return { prediction, text: formatForecast(prediction) };
    },
  };
  return api;
}

/* ---------------- Drop-in routes for a product's server ---------------- */

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function mac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text))).slice(0, 32);
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Standard @conjure routes for any product, on web-standard Request/Response
 * (Cloudflare Workers, Hono via c.req.raw, Deno, Bun; Node via toWebRequest below).
 *
 *   POST {prefix}            { text, context?, source? }  → { mention: false } or { text, ticket, prediction }
 *   GET  {prefix}/{ticket}                                → { text, prediction }   (follow it live)
 *
 * Call it AFTER the product's own sign-in, passing who is signed in. Tickets are signed with
 * `secret` and bound to that person, so only they can follow their forecast, on any instance.
 * Returns null for paths it doesn't own, so it chains with the product's router.
 */
export function createConjureRoutes({ conjure, secret, prefix = "/api/conjure", source: defaultSource } = {}) {
  if (!secret) throw new Error("createConjureRoutes: secret is required (e.g. CONJURE_PRODUCT_KEY)");
  return async function handle(request, { user, context: extraContext } = {}) {
    const url = new URL(request.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    if (!user) return reply(401, { error: "sign in required" });
    if (!conjure) return reply(503, { error: "Conjure isn't connected. Set CONJURE_URL and CONJURE_PRODUCT_KEY." });
    const owner = String(user);
    try {
      if (request.method === "POST" && url.pathname === prefix) {
        if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return reply(415, { error: "send JSON" });
        const body = await request.json().catch(() => null);
        if (!body || typeof body.text !== "string" || body.text.length > 32000) return reply(400, { error: "text is required" });
        const context = [typeof body.context === "string" ? body.context : "", extraContext || ""].filter(Boolean).join("\n\n").slice(0, 30000);
        const source = typeof body.source === "string" ? body.source.slice(0, 60) : defaultSource;
        const out = await conjure.handleMention(body.text, { context, user: owner, source, wait: false });
        if (!out) return reply(200, { mention: false });
        const ticket = out.prediction ? `${out.prediction.id}.${await mac(secret, `${out.prediction.id}|${owner}`)}` : null;
        return reply(200, { mention: true, text: out.text, ticket, prediction: out.prediction });
      }
      const m = /^\/([\w-]+)\.([\w-]+)$/.exec(url.pathname.slice(prefix.length));
      if (request.method === "GET" && m) {
        if (!sameText(m[2], await mac(secret, `${m[1]}|${owner}`))) return reply(404, { error: "no such forecast" });
        const prediction = await conjure.get(m[1]);
        return reply(200, { text: formatForecast(prediction), prediction });
      }
      return reply(404, { error: "not found" });
    } catch (err) {
      if (err instanceof ConjureApiError) return reply(err.status === 429 ? 429 : 502, { error: err.message });
      throw err;
    }
  };
}

/** Node http adapter: turns an IncomingMessage into a Request for createConjureRoutes. */
export async function toWebRequest(req, base = "http://localhost") {
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  return new Request(new URL(req.url, base), { method: req.method, headers, body });
}

/** Node http adapter: writes a Response to a ServerResponse. */
export async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Builds a client from CONJURE_URL and CONJURE_PRODUCT_KEY; null when either is missing. */
export function conjureFromEnv(env = globalThis.process?.env ?? {}) {
  return env.CONJURE_URL && env.CONJURE_PRODUCT_KEY ? createConjure({ url: env.CONJURE_URL, key: env.CONJURE_PRODUCT_KEY }) : null;
}

/** createConjureRoutes from CONJURE_URL + CONJURE_PRODUCT_KEY. Answers 503 until both are set. */
export function conjureRoutesFromEnv(env = globalThis.process?.env ?? {}, options = {}) {
  return createConjureRoutes({ conjure: conjureFromEnv(env), secret: env.CONJURE_PRODUCT_KEY || "conjure-not-configured", ...options });
}
