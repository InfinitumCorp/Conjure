import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProvider, MockProvider, OpenWeightsProvider, DEFAULT_MODEL } from "./providers.js";

// Load the project's .env (if present) so credentials can live in a git-ignored file.
// Variables already set in the environment win.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

/** An open-weight server is configured when its URL (or model) is set, or the conjure-llm
 *  gateway that predictions use is (CONJURE_LLM_URL), which the forge loop then shares. */
export function openWeightsConfigured() {
  return Boolean(process.env.CONJURE_OPEN_WEIGHTS_URL || process.env.CONJURE_OPEN_WEIGHTS_MODEL || process.env.CONJURE_LLM_URL);
}

/** The scripted offline provider is used only when asked for explicitly: CONJURE_MOCK=1 (the
 *  test suite) or the CLI's --mock. Servers never set it; Conjure is live only. */
export const mockMode = () => process.env.CONJURE_MOCK === "1";

/** A real model is configured: Claude credentials or an open-weight server. */
export const liveModelConfigured = () => hasCredentials() || openWeightsConfigured() || process.env.CONJURE_PROVIDER === "open-weights";

export class NoLiveModelError extends Error {
  constructor() {
    super("No live model is configured on this server (set CONJURE_LLM_URL or ANTHROPIC_API_KEY).");
  }
}

export function makeProvider({ mock, model, flaw, delayMs } = {}) {
  // Claude stays first choice, then the open-weight server. There is no silent fallback to a
  // demo: with no model configured this throws, unless the mock was asked for explicitly.
  const forcedOpenWeights = process.env.CONJURE_PROVIDER === "open-weights";
  if (mock === true || mockMode()) return new MockProvider({ flaw, delayMs });
  if (!liveModelConfigured()) throw new NoLiveModelError();
  if (!hasCredentials() || forcedOpenWeights) {
    return new OpenWeightsProvider({ model: model || process.env.CONJURE_OPEN_WEIGHTS_MODEL });
  }
  return new ClaudeProvider({
    model: model || process.env.CONJURE_MODEL || DEFAULT_MODEL,
    fallbacks: process.env.CONJURE_FALLBACKS !== "0",
    timeoutMs: intEnv("CONJURE_TIMEOUT_MS", 1),
    maxRetries: intEnv("CONJURE_MAX_RETRIES", 0) ?? 3,
  });
}

/** Reads an integer setting from the environment; undefined when unset. */
export function intEnv(name, min) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${v}"`);
  return n;
}

export const DEFAULT_OUT = path.resolve(process.env.CONJURE_OUT || "conjured");
