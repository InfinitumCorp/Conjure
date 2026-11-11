// Guessing lockout: an address that sends too many wrong tokens, keys or session
// cookies is refused for a while, so staff tokens and product keys can't be
// brute-forced through the API.

/** The client's address. Behind the local proxy (Caddy on AWS, nginx in Russia), both of which
 * overwrite X-Forwarded-For with the real client, the last entry is the client; otherwise the
 * socket's own address. A client can't spoof this: a forged header from outside is replaced. */
export function clientIp(req) {
  const socket = req.socket?.remoteAddress || "";
  const local = socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1";
  if (local) {
    const fwd = String(req.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (fwd.length) return fwd[fwd.length - 1];
  }
  return socket || "unknown";
}

export class GuessGuard {
  /** @param {{maxFailures?: number, windowMs?: number, lockMs?: number, maxEntries?: number, now?: () => number}} [o] */
  constructor({ maxFailures = 10, windowMs = 15 * 60_000, lockMs = 15 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
    Object.assign(this, { maxFailures, windowMs, lockMs, maxEntries, now });
    /** @type {Map<string, {count: number, first: number, until: number}>} */
    this.entries = new Map();
  }

  /** Seconds until this address may try again, or 0 when it isn't locked out. */
  retryAfter(ip) {
    const e = this.entries.get(ip);
    if (!e || e.until <= this.now()) return 0;
    return Math.ceil((e.until - this.now()) / 1000);
  }

  /** Record one wrong credential; returns true when this failure locks the address out. */
  fail(ip) {
    const t = this.now();
    let e = this.entries.get(ip);
    if (!e || t - e.first > this.windowMs) e = { count: 0, first: t, until: 0 };
    e.count++;
    if (e.count >= this.maxFailures) e.until = t + this.lockMs;
    this.entries.delete(ip); // re-insert so the Map stays ordered oldest first
    this.entries.set(ip, e);
    if (this.entries.size > this.maxEntries) this.prune();
    return e.until > t;
  }

  /** A right credential wipes the slate for that address. */
  succeed(ip) {
    this.entries.delete(ip);
  }

  /** Drop expired entries, then the oldest ones, so memory stays bounded under a flood. */
  prune() {
    const t = this.now();
    for (const [ip, e] of this.entries) if (e.until <= t && t - e.first > this.windowMs) this.entries.delete(ip);
    for (const ip of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(ip);
    }
  }
}
