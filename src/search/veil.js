// Web search for Conjure Search through VEIL Search (infinitumveil.app/api/search): Infinitum's own
// engine, VEILBot's index blended with the web APIs VEIL holds keys for, Hacker News, Stack Overflow
// and Wikipedia. Needs no key here. Turned on with VEIL_SEARCH_URL; the query goes in the POST body.
import { decodeEntities } from "./crawl.js";

/** The VEIL Search endpoint from the environment, or null. Must be https (http only on localhost). */
export function veilUrl(env = process.env) {
  if (!env.VEIL_SEARCH_URL) return null;
  let u;
  try {
    u = new URL(env.VEIL_SEARCH_URL);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return u.protocol === "https:" || (local && u.protocol === "http:") ? u.href : null;
}

const strip = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** One web search through VEIL. Resolves to up to `count` results: [{ url, domain, title, snippet }]. */
export async function veilSearch(query, { count = 10, fetchImpl = fetch, env = process.env, signal } = {}) {
  const url = veilUrl(env);
  if (!url) throw new Error("VEIL Search isn't configured (VEIL_SEARCH_URL)");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ q: String(query).slice(0, 400) }),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`VEIL Search answered ${res.status}: ${out?.error || "error"}`);
  return (Array.isArray(out?.results) ? out.results : [])
    .filter((r) => r && typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, count)
    .map((r) => ({ url: r.url, domain: hostOf(r.url), title: strip(r.title) || r.url, snippet: strip(r.snippet ?? r.description).slice(0, 600) }));
}
