// v2ray GeoIPList / GeoSiteList loader (routercommon proto). No extra dependencies.
// IP → country code, domain → category list. Used only when INFINITUM_GEO_ENABLED is set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLAIN = 0;
const REGEX = 1;
const ROOT = 2;
const FULL = 3;
const CATEGORY_CAP = 100;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const cache = new Map();
const failedDirs = new Set();

export function defaultGeoDir() {
  return path.join(repoRoot, "data", "geo");
}

export function geoEnabled(env = process.env) {
  return TRUTHY.has(String(env.INFINITUM_GEO_ENABLED ?? "").trim().toLowerCase());
}

export function resetGeoCache() {
  cache.clear();
  failedDirs.clear();
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift <= 63n) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: pos };
    shift += 7n;
  }
  throw new Error("truncated varint in geo data");
}

function eachField(buf) {
  const out = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, offset);
      offset = v.offset;
      out.push({ field, value: v.value });
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || n < 0 || offset + n > buf.length) throw new Error("truncated geo message");
      out.push({ field, bytes: buf.subarray(offset, offset + n) });
      offset += n;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated geo message");
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated geo message");
      offset += 4;
    } else {
      throw new Error(`unsupported wire type ${wire} in geo data`);
    }
  }
  return out;
}

function text(bytes) {
  return Buffer.from(bytes).toString("utf8");
}

/** @returns {{ countryCode: string, cidrs: { ip: Buffer, prefix: number }[], inverseMatch: boolean }[]} */
export function decodeGeoIPList(buf) {
  const entries = [];
  for (const field of eachField(buf)) {
    if (field.field !== 1 || !field.bytes) continue;
    let countryCode = "";
    let code = "";
    const cidrs = [];
    let inverseMatch = false;
    for (const inner of eachField(field.bytes)) {
      if (inner.field === 1 && inner.bytes) countryCode = text(inner.bytes);
      else if (inner.field === 2 && inner.bytes) cidrs.push(decodeCidr(inner.bytes));
      else if (inner.field === 3 && inner.value !== undefined) inverseMatch = inner.value !== 0n;
      else if (inner.field === 5 && inner.bytes) code = text(inner.bytes);
    }
    entries.push({ countryCode: countryCode || code, cidrs: cidrs.filter(Boolean), inverseMatch });
  }
  return entries;
}

function decodeCidr(buf) {
  let ip = null;
  let prefix = 0;
  for (const field of eachField(buf)) {
    if (field.field === 1 && field.bytes) ip = Buffer.from(field.bytes);
    else if (field.field === 2 && field.value !== undefined) prefix = Number(field.value);
  }
  if (!ip || (ip.length !== 4 && ip.length !== 16)) return null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.length * 8) return null;
  return { ip, prefix };
}

/** @returns {{ countryCode: string, domains: { type: number, value: string }[] }[]} */
export function decodeGeoSiteList(buf) {
  const entries = [];
  for (const field of eachField(buf)) {
    if (field.field !== 1 || !field.bytes) continue;
    let countryCode = "";
    let code = "";
    const domains = [];
    for (const inner of eachField(field.bytes)) {
      if (inner.field === 1 && inner.bytes) countryCode = text(inner.bytes);
      else if (inner.field === 2 && inner.bytes) domains.push(decodeDomain(inner.bytes));
      else if (inner.field === 4 && inner.bytes) code = text(inner.bytes);
    }
    entries.push({ countryCode: countryCode || code, domains: domains.filter(Boolean) });
  }
  return entries;
}

function decodeDomain(buf) {
  let type = PLAIN;
  let value = "";
  for (const field of eachField(buf)) {
    if (field.field === 1 && field.value !== undefined) type = Number(field.value);
    else if (field.field === 2 && field.bytes) value = text(field.bytes);
  }
  value = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!value || type < PLAIN || type > FULL) return null;
  return { type, value };
}

function cidrMatch(rule, ip) {
  if (rule.ip.length !== ip.length) return false;
  const full = Math.floor(rule.prefix / 8);
  const rem = rule.prefix % 8;
  for (let i = 0; i < full; i++) if (rule.ip[i] !== ip[i]) return false;
  if (!rem) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (rule.ip[full] & mask) === (ip[full] & mask);
}

function isCountryCode(code) {
  return /^[a-z]{2}$/i.test(code);
}

function indexGeoIp(entries) {
  const v4 = new Map();
  const v6 = new Map();
  const wide4 = [];
  const wide6 = [];
  for (const entry of entries) {
    if (!entry.countryCode || entry.inverseMatch) continue;
    for (const cidr of entry.cidrs) {
      const rec = { country: entry.countryCode, ip: cidr.ip, prefix: cidr.prefix };
      if (cidr.ip.length === 4) {
        if (cidr.prefix < 8) wide4.push(rec);
        else pushBucket(v4, cidr.ip[0], rec);
      } else if (cidr.prefix < 16) wide6.push(rec);
      else pushBucket(v6, (cidr.ip[0] << 8) | cidr.ip[1], rec);
    }
  }
  return { v4, v6, wide4, wide6 };
}

function pushBucket(map, key, rec) {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  list.push(rec);
}

function prefer(best, rec) {
  if (!best || rec.prefix > best.prefix) return true;
  if (rec.prefix < best.prefix) return false;
  return isCountryCode(rec.country) && !isCountryCode(best.country);
}

export function parseIp(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith("::ffff:") && s.includes(".")) s = s.slice("::ffff:".length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".").map((n) => Number(n));
    if (parts.some((n) => n > 255)) return null;
    return Buffer.from(parts);
  }
  return parseIpv6(s);
}

function parseIpv6(s) {
  if (s.includes(".")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const expand = (part) => {
    if (!part) return [];
    return part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  };
  const head = expand(halves[0]);
  if (head.some((n) => Number.isNaN(n))) return null;
  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = expand(halves[1]);
    if (tail.some((n) => Number.isNaN(n))) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill(0), ...tail];
  }
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(g, i * 2));
  return out;
}

function indexGeoSite(entries) {
  const full = new Map();
  const roots = new Map();
  const plain = [];
  const regex = [];
  for (const entry of entries) {
    const category = entry.countryCode;
    if (!category) continue;
    for (const domain of entry.domains) {
      if (domain.type === FULL) add(full, domain.value, category);
      else if (domain.type === ROOT) add(roots, domain.value, category);
      else if (domain.type === PLAIN) plain.push({ value: domain.value, category });
      else if (domain.type === REGEX) {
        if (domain.value.length > 1024) continue;
        try {
          regex.push({ re: new RegExp(domain.value, "i"), category });
        } catch {
          // A dataset pattern that this runtime cannot compile is skipped.
        }
      }
    }
  }
  return { full, roots, plain, regex };
}

function add(map, key, category) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(category);
}

export function normalizeDomain(input) {
  if (typeof input !== "string") return "";
  let s = input.trim().toLowerCase();
  if (!s || /\s/.test(s)) return "";
  try {
    if (s.includes("://")) s = new URL(s).hostname;
  } catch {
    return "";
  }
  s = s.split("/")[0].split("?")[0].split("#")[0];
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  const colon = s.lastIndexOf(":");
  if (colon > 0 && s.indexOf(":") === colon && /^\d+$/.test(s.slice(colon + 1))) s = s.slice(0, colon);
  s = s.replace(/^\[|\]$/g, "").replace(/^\.+|\.+$/g, "");
  if (!s || s.length > 253) return "";
  return s;
}

function lookupCountry(index, ip) {
  const bytes = parseIp(ip);
  if (!bytes) return null;
  const wide = bytes.length === 4 ? index.wide4 : index.wide6;
  const bucket = bytes.length === 4 ? index.v4.get(bytes[0]) : index.v6.get((bytes[0] << 8) | bytes[1]);
  let best = null;
  for (const rec of wide) if (cidrMatch(rec, bytes) && prefer(best, rec)) best = rec;
  if (bucket) for (const rec of bucket) if (cidrMatch(rec, bytes) && prefer(best, rec)) best = rec;
  return best ? best.country : null;
}

function lookupCategories(index, domain) {
  const host = normalizeDomain(domain);
  if (!host) return [];
  const found = new Set();
  const exact = index.full.get(host);
  if (exact) for (const category of exact) found.add(category);
  let cur = host;
  while (cur) {
    const set = index.roots.get(cur);
    if (set) for (const category of set) found.add(category);
    const dot = cur.indexOf(".");
    if (dot < 0) break;
    cur = cur.slice(dot + 1);
  }
  for (const rule of index.plain) if (host.includes(rule.value)) found.add(rule.category);
  for (const rule of index.regex) if (rule.re.test(host)) found.add(rule.category);
  return [...found].sort().slice(0, CATEGORY_CAP);
}

/** Open decoded lists, or raw GeoIPList / GeoSiteList buffers. */
export function openGeo({ geoip, geosite }) {
  const ipIndex = indexGeoIp(Array.isArray(geoip) ? geoip : decodeGeoIPList(geoip));
  const siteIndex = indexGeoSite(Array.isArray(geosite) ? geosite : decodeGeoSiteList(geosite));
  return {
    countryForIp(ip) {
      return lookupCountry(ipIndex, ip);
    },
    categoriesForDomain(domain) {
      return lookupCategories(siteIndex, domain);
    },
  };
}

export function loadGeoFiles(dir) {
  const root = path.resolve(dir);
  const geoip = fs.readFileSync(path.join(root, "geoip.dat"));
  const geosite = fs.readFileSync(path.join(root, "geosite.dat"));
  return openGeo({ geoip, geosite });
}

export function loadGeo(dir = defaultGeoDir()) {
  const key = path.resolve(dir);
  if (cache.has(key)) return cache.get(key);
  if (failedDirs.has(key)) return null;
  try {
    const db = loadGeoFiles(key);
    cache.set(key, db);
    return db;
  } catch (err) {
    failedDirs.add(key);
    throw err;
  }
}

export function describeTraffic(db, { ip, domain } = {}) {
  if (!db) return null;
  return {
    country: db.countryForIp(ip),
    categories: db.categoriesForDomain(domain),
  };
}

function isLoopback(ip) {
  const n = String(ip || "").trim().toLowerCase().replace(/^::ffff:/, "");
  return n === "127.0.0.1" || n === "::1";
}

/** Socket address. A forwarded header is read only from a loopback peer, and only for this annotation. */
export function clientAddress(req) {
  const sock = req?.socket?.remoteAddress || "";
  if (isLoopback(sock)) {
    const raw = req?.headers?.["x-forwarded-for"];
    const header = Array.isArray(raw) ? raw.join(",") : raw;
    if (typeof header === "string") {
      const first = header.split(",")[0].trim();
      if (first) return first;
    }
  }
  return sock;
}

/**
 * Cyber geo note for a product request. Returns null when the flag is off
 * (the default) or the datasets are not available. Never decides access.
 */
export function annotateProductRequest(req, { domain = "", env = process.env, dir } = {}) {
  if (!geoEnabled(env)) return null;
  const where = dir || env.INFINITUM_GEO_DIR || defaultGeoDir();
  try {
    const db = loadGeo(where);
    return describeTraffic(db, { ip: clientAddress(req), domain });
  } catch (err) {
    console.error(`cyber geo annotation unavailable: ${err.message}`);
    return null;
  }
}
