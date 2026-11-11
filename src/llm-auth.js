// How Conjure signs its calls to the model server.
//
// Normally that is a fixed key (CONJURE_LLM_KEY, sent as a Bearer token). On a Yandex Cloud VM with a
// service account attached (Conjure Russia), CONJURE_LLM_AUTH=yandex-vm uses that account instead:
// the VM's metadata service hands out short-lived IAM tokens, so no key exists to copy, leak or rotate.
// Tokens are cached until five minutes before they expire.

const METADATA_URL = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const MARGIN_MS = 5 * 60_000;

let cached = null; // { token, expiresAt }
let pending = null;

/** True when calls should be signed with the VM's service account. */
export const vmAuth = (env = process.env) => env.CONJURE_LLM_AUTH === "yandex-vm";

async function vmToken({ fetchImpl = fetch, now = Date.now } = {}) {
  if (cached && now() < cached.expiresAt - MARGIN_MS) return cached.token;
  // One refresh at a time, however many model calls are waiting.
  pending ??= (async () => {
    try {
      const res = await fetchImpl(METADATA_URL, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`metadata service answered ${res.status}`);
      const body = await res.json();
      if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("no access_token in the answer");
      cached = { token: body.access_token, expiresAt: now() + Math.max(60, Number(body.expires_in) || 0) * 1000 };
      return cached.token;
    } catch (err) {
      throw new Error(`Couldn't get a Yandex token from this VM (is a service account attached?): ${err.message}`);
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/**
 * The Authorization header for one model call.
 * @param {string} key a fixed key, used when VM auth is off
 * @param {{ vm?: boolean, fetchImpl?: typeof fetch, now?: () => number }} [o] vm: whether VM auth may apply to this server
 */
export async function authHeaders(key, { vm = true, fetchImpl, now } = {}) {
  if (vm && vmAuth()) return { authorization: `Bearer ${await vmToken({ fetchImpl, now })}` };
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** Tests only. */
export function resetTokenCache() {
  cached = null;
  pending = null;
}
