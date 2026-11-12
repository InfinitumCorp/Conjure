// Conjure model gateway on Cloudflare Workers AI (open-weight models). Deploy: cf deploy (from this folder).
import { bindings, defineConfig, exports } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "conjure-llm",
    entrypoint,
    compatibilityDate: "2026-10-01",
    // Global users run on US servers (Ashburn, Virginia); Russia is served by the ru.* copies on Yandex Cloud.
    placement: { region: "gcp:us-east4" },
    exports: {
      // Per-day neuron ledger that keeps Workers AI inside its free allowance.
      Budget: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      AI: bindings.ai(),
      GATEWAY_KEY: bindings.secret(),
      // Qwen3 30B (Apache 2.0): strong reasoning, tool calling, low cost per forecast.
      DEFAULT_MODEL: bindings.text("@cf/qwen/qwen3-30b-a3b-fp8"),
      // Workers AI includes 10,000 neurons a day at no charge; stop at 9,500 for margin.
      DAILY_NEURONS: bindings.text("9500"),
      // No-account free fallbacks (OVHcloud, Pollinations, LLM7) once the allowance is used up.
      // Turned on at the owner's request on 2026-11-11, accepting that these anonymous tiers may log prompts.
      KEYLESS_FALLBACKS: bindings.text("on"),
    },
  },
});
