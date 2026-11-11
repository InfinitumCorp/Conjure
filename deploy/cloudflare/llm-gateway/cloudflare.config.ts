// Conjure model gateway on Cloudflare Workers AI (open-weight models). Deploy: cf deploy (from this folder).
import { bindings, defineConfig } from "cf/config";

import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "conjure-llm",
    entrypoint,
    compatibilityDate: "2026-10-01",
    env: {
      AI: bindings.ai(),
      GATEWAY_KEY: bindings.secret(),
      // Qwen3 30B (Apache 2.0): strong reasoning, tool calling, low cost per forecast.
      DEFAULT_MODEL: bindings.text("@cf/qwen/qwen3-30b-a3b-fp8"),
    },
  },
});
