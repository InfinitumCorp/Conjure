// Fetches public web pages for Conjure Search and turns them into readable text.
//
// The server is a cloud VM: its metadata service (169.254.169.254) hands out cloud credentials and
// Conjure itself listens on localhost. So a page is only fetched from a public address. The address is
// checked when the socket connects (the DNS answer actually used, so a rebinding DNS server can't swap
// it), and again on every redirect. Pages are capped in size and time, and only HTML or text is read.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;
const UA = "ConjureBot/1.0 (+https://conjure.infinitumcorporation.ai; Infinitum Corporation research)";

/** True for addresses that must never be fetched: private, loopback, link-local, metadata, multicast, reserved. */
export function blockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return blockedAddress(mapped[1]);
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") ||
      v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff") || v.startsWith("64:ff9b");
  }
  return true;
}

/** A DNS lookup that refuses blocked addresses; used by the socket itself. */
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !blockedAddress(a.address));
    if (!ok.length) return cb(Object.assign(new Error(`${hostname} is not a public address`), { code: "EBLOCKED" }));
    if (options?.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

/** Accepts only http(s) URLs on the standard ports, with no credentials and no bare IPs that are blocked. */
export function allowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && blockedAddress(host)) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return null;
  u.hash = "";
  return u;
}

function getOnce(u, signal) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "GET",
      lookup: guardedLookup,
      signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "accept-encoding": "gzip, deflate, br", "accept-language": "ru,en;q=0.8" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      const type = String(res.headers["content-type"] || "");
      if (status >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
        res.resume();
        return reject(new Error(`not a web page (${type.split(";")[0]})`));
      }
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0;
      stream.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          resolve({ body: Buffer.concat(chunks).toString("utf8"), type, truncated: true });
        } else chunks.push(c);
      });
      stream.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), type }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetches one public page. Resolves to { url, title, text } or rejects with a short reason.
 * @param {string} raw
 * @param {{ signal?: AbortSignal, get?: typeof getOnce }} [o] get: tests swap the network call
 */
export async function fetchPage(raw, { signal, get = getOnce } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = allowedUrl(url);
    if (!u) throw new Error("not a public web address");
    const r = await get(u, sig);
    if (r.redirect) {
      url = r.redirect;
      continue;
    }
    const page = /html/i.test(r.type) || /<html|<body|<p[\s>]/i.test(r.body.slice(0, 2000)) ? extractText(r.body) : { title: "", text: r.body };
    return { url: u.toString(), ...page };
  }
  throw new Error("too many redirects");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: the main article when there is one, without scripts, menus or footers. */
export function extractText(html) {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 400) body = main;
  const text = decodeEntities(
    body
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}
