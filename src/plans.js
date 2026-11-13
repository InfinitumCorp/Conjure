// Conjure plans and the Cumulus billing hub.
//
// Payments never touch this server. People subscribe, change or cancel on the Cumulus billing hub
// (mail.cumuluscloud.app/api/billing/...), which signs them in with Cumulus ID and opens Stripe
// Checkout through the infinitum-revenue Worker. That Worker holds the Stripe keys; Conjure holds none.
//
// To unlock paid features, Conjure asks the hub what the signed-in person pays for:
//   GET <hub>/api/billing/me   Authorization: Bearer <the person's Cumulus ID access token>
// and reads the "conjure" entry of `products`.
//
// Plan ids, prices and the conjure_build meter live in the revenue catalog (infinitum-revenue#23).

/** What each plan allows. `builds` is verified builds (new builds and refinements) per calendar month (UTC). */
export const PLANS = {
  conjure_free: { id: "conjure_free", name: "Free", builds: 5, concurrent: 1 },
  conjure_pro: { id: "conjure_pro", name: "Pro", builds: 100, concurrent: 2 },
  conjure_team: { id: "conjure_team", name: "Team", builds: 300, concurrent: 3, perSeat: true },
};

/** Staff and owners: no monthly cap; one run at a time unless CONJURE_STAFF_CONCURRENCY says more. */
export const STAFF_PLAN = { id: "staff", name: "Staff", builds: Infinity, concurrent: 1 };

/** Subscription states that unlock a paid plan (the same set the hub uses). */
const PAID = new Set(["trialing", "active", "past_due", "bundled"]);
const RANK = { conjure_free: 0, conjure_pro: 1, conjure_team: 2 };

export const DEFAULT_HUB = "https://mail.cumuluscloud.app";

/** Free-plan concurrency can be raised or lowered per server (CONJURE_USER_CONCURRENCY). */
export function planTable(env = process.env) {
  const free = Math.max(1, Math.min(10, Number(env.CONJURE_USER_CONCURRENCY) || PLANS.conjure_free.concurrent));
  const staff = Math.max(1, Math.min(10, Number(env.CONJURE_STAFF_CONCURRENCY) || STAFF_PLAN.concurrent));
  return { ...PLANS, conjure_free: { ...PLANS.conjure_free, concurrent: free }, staff: { ...STAFF_PLAN, concurrent: staff } };
}

/** The best paid Conjure plan in a /api/billing/me answer, or conjure_free. */
export function conjurePlanFrom(me) {
  let best = "conjure_free";
  for (const p of Array.isArray(me?.products) ? me.products : []) {
    if (p?.product !== "conjure" || !PAID.has(p.status) || !(p.plan in RANK)) continue;
    if (RANK[p.plan] > RANK[best]) best = p.plan;
  }
  return best;
}

/**
 * Asks the billing hub which Conjure plan a person has, with a short per-person cache.
 * Never throws: when the hub can't be reached it keeps the last answer, or falls back to Free.
 */
export class PlanLookup {
  constructor({ hub = DEFAULT_HUB, fetchImpl = fetch, ttlMs = 5 * 60_000, env = process.env } = {}) {
    this.hub = String(hub || DEFAULT_HUB).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.ttlMs = ttlMs;
    this.table = planTable(env);
    this.cache = new Map(); // user id -> { plan, at, status }
  }

  /** Links people follow to subscribe or manage billing. `returnUrl` must be a Conjure origin the hub accepts. */
  links(returnUrl) {
    const r = encodeURIComponent(returnUrl);
    return {
      pro: `${this.hub}/api/billing/subscribe?plan=conjure_pro&return=${r}`,
      team: `${this.hub}/api/billing/subscribe?plan=conjure_team&return=${r}`,
      manage: `${this.hub}/api/billing/manage?return=${r}`,
    };
  }

  /**
   * { plan, status } for a person. status: "ok" (hub answered), "signin" (token missing or expired:
   * sign in again to refresh), "unavailable" (hub unreachable; last known plan or Free).
   */
  async planFor(userId, token) {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < this.ttlMs) return { plan: this.table[hit.plan], status: hit.status };
    if (!token) return this.remember(userId, hit?.status === "ok" ? hit.plan : "conjure_free", "signin");
    let res;
    try {
      res = await this.fetch(`${this.hub}/api/billing/me`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return this.remember(userId, hit?.plan ?? "conjure_free", "unavailable", 60_000);
    }
    if (res.status === 401) return this.remember(userId, "conjure_free", "signin");
    if (!res.ok) return this.remember(userId, hit?.plan ?? "conjure_free", "unavailable", 60_000);
    const me = await res.json().catch(() => null);
    return this.remember(userId, conjurePlanFrom(me), "ok");
  }

  /** Forget a person's cached plan (after they return from checkout). */
  forget(userId) {
    this.cache.delete(userId);
  }

  remember(userId, plan, status, ttl) {
    // Shorter memory for failures, so a recovered hub is asked again soon.
    this.cache.set(userId, { plan, status, at: Date.now() - (ttl ? this.ttlMs - ttl : 0) });
    return { plan: this.table[plan], status };
  }
}
