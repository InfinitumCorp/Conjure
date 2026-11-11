// Resilience for model servers: retry with backoff, endpoint failover, circuit
// breaking, and secret redaction. Original implementation of well-known
// patterns (retry + Retry-After as in payment-provider SDKs, outlier-ejecting
// circuit breakers as in service proxies, OWASP LLM-Top-10 data-leak guidance).
// Zero dependencies; identical copies live in Conjure (src/resilience.js).

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Milliseconds from a Retry-After header: delta-seconds or an HTTP date. null when absent/invalid. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Exponential backoff with equal jitter; a server's Retry-After wins but is capped. */
export function retryDelayMs(attempt, { baseMs = 400, maxMs = 8000, retryAfterMs = null, random = Math.random } = {}) {
  if (retryAfterMs != null) return Math.min(retryAfterMs, maxMs);
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Closed -> open after `failures` in a row -> half-open (one probe) after `cooldownMs`. */
export class CircuitBreaker {
  constructor({ failures = 3, cooldownMs = 30000, now = () => Date.now() } = {}) {
    Object.assign(this, { threshold: failures, cooldownMs, now, count: 0, openedAt: null, probing: false });
  }
  get state() {
    if (this.openedAt == null) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }
  /** May a request go to this endpoint right now? Half-open admits a single probe. */
  allow() {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probing) { this.probing = true; return true; }
    return false;
  }
  success() { this.count = 0; this.openedAt = null; this.probing = false; }
  failure() {
    this.probing = false;
    if (++this.count >= this.threshold) this.openedAt = this.now();
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const trim = (u) => String(u).trim().replace(/\/+$/, '');

/** Comma-separated base URLs -> clean list. */
export const parseUrls = (value, fallback = []) => {
  const list = String(value || '').split(',').map(trim).filter(Boolean);
  return list.length ? list : fallback;
};

/**
 * An ordered set of interchangeable model servers. Requests go to the first
 * healthy one; retryable failures back off and retry, then fail over to the next.
 * Returns the last Response when every server answered with an error status (so
 * callers can surface the server's own message), and throws only when nothing
 * answered at all.
 */
export class EndpointPool {
  constructor(urls, { retries = 2, baseMs = 400, maxMs = 8000, breaker = {}, sleep = sleepMs, random = Math.random } = {}) {
    this.urls = urls.map(trim);
    this.retries = retries;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.sleep = sleep;
    this.random = random;
    this.breakers = new Map(this.urls.map((u) => [u, new CircuitBreaker(breaker)]));
  }

  health() {
    return this.urls.map((url) => ({ url, state: this.breakers.get(url).state }));
  }

  async fetch(path, init = {}, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
    let lastRes = null;
    let lastErr = null;
    let tried = 0;
    for (const url of this.urls) {
      const breaker = this.breakers.get(url);
      if (!breaker.allow()) continue;
      tried++;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
        try {
          const res = await fetchImpl(`${url}${path}`, init);
          if (!RETRYABLE_STATUS.has(res.status)) {
            breaker.success();
            return res;
          }
          lastRes = res;
          lastErr = null;
          if (attempt < this.retries) {
            await this.sleep(retryDelayMs(attempt, { baseMs: this.baseMs, maxMs: this.maxMs, random: this.random, retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')) }));
            continue;
          }
        } catch (err) {
          if (init.signal?.aborted) throw err;
          lastErr = err;
          lastRes = null;
          if (attempt < this.retries) {
            await this.sleep(retryDelayMs(attempt, { baseMs: this.baseMs, maxMs: this.maxMs, random: this.random }));
            continue;
          }
        }
        breaker.failure();
      }
    }
    if (!tried) throw new Error('All model servers are cooling down after repeated failures. Try again shortly.');
    if (lastRes) return lastRes;
    throw lastErr ?? new Error('The model server could not be reached.');
  }
}

const pools = new Map();
/** One shared pool (and so one set of circuit breakers) per URL list and policy within this isolate. */
export function poolFor(urls, opts = {}) {
  const key = `${urls.join(',')}|${opts.retries ?? ''}|${opts.baseMs ?? ''}`;
  if (!pools.has(key)) pools.set(key, new EndpointPool(urls, opts));
  return pools.get(key);
}

// ---------------------------------------------------------------------------- redaction

const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['api-key', /\bsk-[A-Za-z0-9]{32,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['bearer-token', /\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g],
];

/** Replace credentials with [REDACTED:kind] so they never leave for a model server. */
export function redactSecrets(text) {
  let count = 0;
  let out = String(text ?? '');
  for (const [kind, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m, g1) => { count++; return g1 === 'Bearer' ? `Bearer [REDACTED:${kind}]` : `[REDACTED:${kind}]`; });
  }
  return { text: out, count };
}

/** Redact every string message body in an OpenAI-style messages array (non-mutating). */
export function redactMessages(messages = []) {
  let count = 0;
  const redacted = messages.map((m) => {
    if (typeof m?.content === 'string') {
      const r = redactSecrets(m.content);
      count += r.count;
      return r.count ? { ...m, content: r.text } : m;
    }
    if (Array.isArray(m?.content)) {
      return { ...m, content: m.content.map((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return part;
        const r = redactSecrets(part.text);
        count += r.count;
        return r.count ? { ...part, text: r.text } : part;
      }) };
    }
    return m;
  });
  return { messages: redacted, count };
}
