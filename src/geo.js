// v2ray GeoIPList / GeoSiteList loader. No extra dependencies: a small protobuf
// reader for the two messages v2fly publishes as geoip.dat and geosite.dat.
// Lookups are annotations. They do not block, redirect, or change a forecast.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DAT = 64 * 1024 * 1024;
const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["0", "false", "off", "no"]);

const cache = new Map();

export function geoDataDir() {
  if (process.env.INFINITUM_GEO_DIR) return path.resolve(process.env.INFINITUM_GEO_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
}

/** Opt-in. Env INFINITUM_GEO_ENABLED forces on or off; otherwise the saved toggle decides. Default off. */
export function geoEnabled(env = process.env, geoRouting = false) {
  const raw = String(env?.INFINITUM_GEO_ENABLED ?? "").trim().toLowerCase();
  if (OFF.has(raw)) return false;
  if (ON.has(raw)) return true;
  return geoRouting === true;
}

export function resetGeoCache() {
  cache.clear();
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length && shift <= 28) {
    const byte = buf[i++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7;
  }
  throw new Error("truncated geo dat");
}

function fields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new Error("bad geo dat field");
    if (wire === 0) {
      const [val, next] = readVarint(buf, afterTag);
      out.push({ field, wire, val });
      i = next;
    } else if (wire === 2) {
      const [len, start] = readVarint(buf, afterTag);
      const end = start + len;
      if (len < 0 || end > buf.length) throw new Error("truncated geo dat");
      out.push({ field, wire, data: buf.subarray(start, end) });
      i = end;
    } else if (wire === 1) {
      if (afterTag + 8 > buf.length) throw new Error("truncated geo dat");
      i = afterTag + 8;
    } else if (wire === 5) {
      if (afterTag + 4 > buf.length) throw new Error("truncated geo dat");
      i = afterTag + 4;
    } else {
      throw new Error(`unsupported geo dat wire type ${wire}`);
    }
  }
  return out;
}

function asText(buf) {
  return Buffer.from(buf).toString("utf8");
}

function decodeCidr(buf) {
  let ip = null;
  let prefix = 0;
  for (const field of fields(buf)) {
    if (field.field === 1 && field.wire === 2) ip = Buffer.from(field.data);
    else if (field.field === 2 && field.wire === 0) prefix = field.val;
  }
  if (!ip || (ip.length !== 4 && ip.length !== 16)) return null;
  return { ip, prefix };
}

export function decodeGeoIpList(buf) {
  const entries = [];
  for (const field of fields(buf)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    let country = "";
    let reverse = false;
    const cidrs = [];
    for (const inner of fields(field.data)) {
      if (inner.field === 1 && inner.wire === 2) country = asText(inner.data);
      else if (inner.field === 2 && inner.wire === 2) {
        const cidr = decodeCidr(inner.data);
        if (cidr) cidrs.push(cidr);
      } else if (inner.field === 3 && inner.wire === 0) reverse = inner.val !== 0;
    }
    if (country) entries.push({ country, reverse, cidrs });
  }
  return entries;
}

export function decodeGeoSiteList(buf) {
  const entries = [];
  for (const field of fields(buf)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    let category = "";
    const domains = [];
    for (const inner of fields(field.data)) {
      if (inner.field === 1 && inner.wire === 2) category = asText(inner.data);
      else if (inner.field === 2 && inner.wire === 2) {
        let type = 0;
        let value = "";
        for (const part of fields(inner.data)) {
          if (part.field === 1 && part.wire === 0) type = part.val;
          else if (part.field === 2 && part.wire === 2) value = asText(part.data);
        }
        if (value) domains.push({ type, value });
      }
    }
    if (category) entries.push({ category, domains });
  }
  return entries;
}

function maskShift(prefix, bits) {
  if (prefix <= 0) return bits;
  if (prefix >= bits) return 0;
  return bits - prefix;
}

function v4Contains(ip, base, prefix) {
  if (prefix <= 0) return prefix === 0;
  if (prefix > 32) return false;
  const shift = maskShift(prefix, 32);
  return (ip >>> shift) === (base >>> shift);
}

function v6Contains(ip, base, prefix) {
  if (prefix <= 0) return prefix === 0;
  if (prefix > 128) return false;
  const shift = BigInt(maskShift(prefix, 128));
  return (ip >> shift) === (base >> shift);
}

class RangeIndex {
  constructor() {
    this.v4 = Array.from({ length: 256 }, () => []);
    this.v4wide = [];
    this.v6 = Array.from({ length: 256 }, () => []);
    this.v6wide = [];
    this.reverse = [];
  }

  add(entry, order) {
    if (entry.reverse) {
      this.reverse.push({ country: entry.country, order, cidrs: entry.cidrs });
      return;
    }
    for (const cidr of entry.cidrs) this.addCidr(cidr, entry.country, order);
  }

  addCidr(cidr, country, order) {
    if (cidr.ip.length === 4) {
      let ip = 0;
      for (const byte of cidr.ip) ip = ((ip << 8) | byte) >>> 0;
      const item = { base: ip, prefix: cidr.prefix, country, order };
      if (item.prefix < 8) this.v4wide.push(item);
      else this.v4[ip >>> 24].push(item);
    } else if (cidr.ip.length === 16) {
      let ip = 0n;
      for (const byte of cidr.ip) ip = (ip << 8n) | BigInt(byte);
      const item = { base: ip, prefix: cidr.prefix, country, order };
      const first = Number((ip >> 120n) & 0xffn);
      if (item.prefix < 8) this.v6wide.push(item);
      else this.v6[first].push(item);
    }
  }

  best(lists, match) {
    let win = null;
    for (const list of lists) {
      for (const item of list) {
        if (!match(item)) continue;
        if (!win || item.prefix > win.prefix || (item.prefix === win.prefix && item.order < win.order)) win = item;
      }
    }
    return win;
  }

  lookupV4(ip) {
    return this.best([this.v4[ip >>> 24], this.v4wide], (item) => v4Contains(ip, item.base, item.prefix));
  }

  lookupV6(ip) {
    const first = Number((ip >> 120n) & 0xffn);
    return this.best([this.v6[first], this.v6wide], (item) => v6Contains(ip, item.base, item.prefix));
  }

  reverseV4(ip) {
    let win = null;
    for (const entry of this.reverse) {
      const cidrs = entry.cidrs.filter((c) => c.ip.length === 4);
      if (!cidrs.length) continue;
      const inside = cidrs.some((c) => {
        let base = 0;
        for (const byte of c.ip) base = ((base << 8) | byte) >>> 0;
        return v4Contains(ip, base, c.prefix);
      });
      if (!inside && (!win || entry.order < win.order)) win = entry;
    }
    return win;
  }

  reverseV6(ip) {
    let win = null;
    for (const entry of this.reverse) {
      const cidrs = entry.cidrs.filter((c) => c.ip.length === 16);
      if (!cidrs.length) continue;
      const inside = cidrs.some((c) => {
        let base = 0n;
        for (const byte of c.ip) base = (base << 8n) | BigInt(byte);
        return v6Contains(ip, base, c.prefix);
      });
      if (!inside && (!win || entry.order < win.order)) win = entry;
    }
    return win;
  }
}

function pushRule(map, key, category, order) {
  const list = map.get(key);
  if (list) list.push({ category, order });
  else map.set(key, [{ category, order }]);
}

class SiteIndex {
  constructor(entries) {
    this.full = new Map();
    this.suffix = new Map();
    this.plain = [];
    this.regex = [];
    let order = 0;
    for (const entry of entries) {
      for (const domain of entry.domains) {
        const value = domain.value.trim().toLowerCase().replace(/\.$/, "");
        if (!value) continue;
        const ruleOrder = order++;
        if (domain.type === 3) pushRule(this.full, value, entry.category, ruleOrder);
        else if (domain.type === 2) pushRule(this.suffix, value, entry.category, ruleOrder);
        else if (domain.type === 1) {
          if (value.length > 200) continue;
          try {
            this.regex.push({ re: new RegExp(value, "i"), category: entry.category, order: ruleOrder });
          } catch {
            // A dataset pattern that is not a JavaScript regular expression is skipped.
          }
        } else if (domain.type === 0) this.plain.push({ value, category: entry.category, order: ruleOrder });
      }
    }
  }

  categories(host) {
    const name = String(host || "").trim().toLowerCase().replace(/\.$/, "");
    if (!name || name.length > 253) return [];
    const hits = [];
    const take = (list) => {
      if (list) hits.push(...list);
    };
    take(this.full.get(name));
    let rest = name;
    while (rest) {
      take(this.suffix.get(rest));
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      rest = rest.slice(dot + 1);
    }
    for (const rule of this.plain) if (name.includes(rule.value)) hits.push(rule);
    for (const rule of this.regex) if (rule.re.test(name)) hits.push(rule);
    hits.sort((a, b) => a.order - b.order);
    const out = [];
    for (const hit of hits) if (!out.includes(hit.category)) out.push(hit.category);
    return out;
  }
}

export class GeoDB {
  constructor(ipBuf, siteBuf) {
    const ips = decodeGeoIpList(ipBuf);
    this.ranges = new RangeIndex();
    ips.forEach((entry, order) => this.ranges.add(entry, order));
    this.sites = new SiteIndex(decodeGeoSiteList(siteBuf));
  }

  /** Longest-prefix country code, or null. */
  lookupIp(raw) {
    const norm = normalizeIp(raw);
    if (!norm) return null;
    if (!norm.includes(":")) {
      const hit = this.ranges.lookupV4(ipv4ToInt(norm)) || this.ranges.reverseV4(ipv4ToInt(norm));
      return hit?.country ?? null;
    }
    const v6 = parseIpv6(norm);
    if (v6 == null) return null;
    if ((v6 >> 32n) === 0xffffn) {
      const mapped = this.ranges.lookupV4(Number(v6 & 0xffffffffn)) || this.ranges.reverseV4(Number(v6 & 0xffffffffn));
      if (mapped) return mapped.country;
    }
    const hit = this.ranges.lookupV6(v6) || this.ranges.reverseV6(v6);
    return hit?.country ?? null;
  }

  /** Category codes whose domain rules match, in dataset order. */
  lookupCategories(domain) {
    return this.sites.categories(domain);
  }

  /** First matching category, or null. */
  lookupCategory(domain) {
    return this.lookupCategories(domain)[0] ?? null;
  }
}

function readDat(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_DAT) throw new Error(`geo dat is too large: ${file}`);
  return buf;
}

export function loadGeoDb(dir) {
  const ipPath = path.join(dir, "geoip.dat");
  const sitePath = path.join(dir, "geosite.dat");
  if (!fs.existsSync(ipPath) || !fs.existsSync(sitePath)) {
    throw new Error(`missing geoip.dat or geosite.dat in ${dir}`);
  }
  return new GeoDB(readDat(ipPath), readDat(sitePath));
}

export function geoDb(dir = geoDataDir()) {
  const key = path.resolve(dir);
  if (!cache.has(key)) cache.set(key, loadGeoDb(key));
  return cache.get(key);
}

export function ipv4ToInt(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n * 256 + octet) >>> 0;
  }
  return n;
}

export function parseIpv6(value) {
  let zone = String(value).toLowerCase();
  const percent = zone.indexOf("%");
  if (percent >= 0) zone = zone.slice(0, percent);
  if (zone.includes(".")) {
    const last = zone.lastIndexOf(":");
    if (last < 0) return null;
    const v4 = ipv4ToInt(zone.slice(last + 1));
    if (v4 == null) return null;
    zone = `${zone.slice(0, last + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = zone.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const parts = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head;
  if (parts.length !== 8) return null;
  let n = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    n = (n << 16n) | BigInt(parseInt(part, 16));
  }
  return n;
}

/** An IP literal, or null. Names are not resolved. */
export function normalizeIp(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (!value || value.length > 64) return null;
  if (value.startsWith("[") && value.includes("]")) value = value.slice(1, value.indexOf("]"));
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith("::ffff:") && value.includes(".")) {
    const mapped = value.slice("::ffff:".length);
    return ipv4ToInt(mapped) == null ? null : mapped;
  }
  if (value.includes(".")) return ipv4ToInt(value) == null ? null : value;
  if (value.includes(":")) return parseIpv6(value) == null ? null : value;
  return null;
}

export function chooseClientIp(explicit, socketIp) {
  return normalizeIp(explicit) || normalizeIp(socketIp) || null;
}

const HOST_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;

export function domainsIn(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const seen = new Set();
  for (const match of text.toLowerCase().matchAll(HOST_RE)) {
    const host = match[0].replace(/\.$/, "");
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(host);
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * Policy annotation for an address and some text. Returns null when nothing
 * in the datasets matches, so a miss leaves the caller unchanged.
 * `route` is a label only: country:<code> or category:<name>.
 */
export function annotate({ dir = geoDataDir(), ip, text } = {}) {
  const db = geoDb(dir);
  const country = ip ? db.lookupIp(ip) : null;
  const categories = [];
  for (const host of domainsIn(text || "")) {
    for (const category of db.lookupCategories(host)) {
      if (!categories.includes(category)) categories.push(category);
    }
  }
  const route = country ? `country:${country}` : categories[0] ? `category:${categories[0]}` : null;
  if (!route) return null;
  return { country, categories, route };
}
