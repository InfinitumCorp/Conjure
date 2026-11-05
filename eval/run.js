#!/usr/bin/env node
// Eval harness: run a fixed set of intents through Conjure and record how it did.
//   node eval/run.js --mock          offline, free (checks the harness itself)
//   node eval/run.js --yes           live against Claude (spends API credit)
//   node eval/run.js --only todo,markdown --yes
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conjure, ConjureCancelled } from "../src/engine.js";
import { makeProvider } from "../src/config.js";
import { emptyUsage, addUsage } from "../src/pricing.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    mock: { type: "boolean" },
    model: { type: "string" },
    only: { type: "string" },
    yes: { type: "boolean", short: "y" },
    out: { type: "string" },
  },
});

const all = JSON.parse(await fs.readFile(path.join(here, "intents.json"), "utf8"));
const wanted = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;
const cases = wanted ? all.filter((c) => wanted.has(c.id)) : all;
if (cases.length === 0) {
  console.error(`No intents match --only ${values.only}. Known ids: ${all.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

const provider = makeProvider({ mock: values.mock ? true : undefined, model: values.model });
if (provider.name !== "mock" && !values.yes) {
  console.error(`This would run ${cases.length} live build(s) on ${provider.model} and spend API credit.\nRe-run with --yes to proceed, or --mock to test offline.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(values.out ?? path.join("conjured", `eval-${stamp}`));
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

console.log(`✦ Conjure eval · ${cases.length} case(s) · provider=${provider.name} model=${provider.model}\n`);
const rows = [];
for (const c of cases) {
  // A fresh provider per case keeps mock state (and any per-run state) independent.
  const p = makeProvider({ mock: provider.name === "mock" ? true : undefined, model: values.model });
  process.stdout.write(`  ${c.id.padEnd(12)} `);
  const started = Date.now();
  try {
    const r = await conjure({ intent: c.intent, provider: p, outDir, signal: controller.signal });
    const failed = r.verification.results.filter((x) => !x.ok).map((x) => `${x.file}[${x.check}]`);
    rows.push({ id: c.id, ok: r.verification.ok, repairs: r.verification.repairs, files: r.files.length, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, failed, folder: path.basename(r.workspace) });
    console.log(`${r.verification.ok ? "✓" : "✗"} ${r.verification.repairs} repair(s), ${r.files.length} files, ${(r.durationMs / 1000).toFixed(1)}s${r.costUsd != null ? `, ~$${r.costUsd.toFixed(4)}` : ""}`);
  } catch (err) {
    if (err instanceof ConjureCancelled) {
      console.log("cancelled");
      break;
    }
    rows.push({ id: c.id, ok: false, error: err.message, durationMs: Date.now() - started, usage: emptyUsage(), costUsd: null });
    console.log(`✗ error: ${err.message}`);
  }
}

const total = rows.reduce((u, r) => addUsage(u, r.usage), emptyUsage());
const costs = rows.map((r) => r.costUsd).filter((c) => c != null);
const summary = {
  at: new Date().toISOString(),
  provider: provider.name,
  model: provider.model,
  cases: rows.length,
  passed: rows.filter((r) => r.ok).length,
  firstTryPassed: rows.filter((r) => r.ok && r.repairs === 0).length,
  totalRepairs: rows.reduce((n, r) => n + (r.repairs ?? 0), 0),
  usage: total,
  costUsd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000 : null,
  durationMs: rows.reduce((n, r) => n + r.durationMs, 0),
  rows,
};

const md = [
  `# Conjure eval — ${summary.at}`,
  ``,
  `Provider **${summary.provider}**, model **${summary.model}**. Passed **${summary.passed}/${summary.cases}** (${summary.firstTryPassed} on the first try, ${summary.totalRepairs} repair round(s) in total).`,
  `Tokens: ${total.input_tokens} in, ${total.output_tokens} out, ${total.cache_read_input_tokens} cache read. ${summary.costUsd != null ? `Estimated cost: $${summary.costUsd.toFixed(4)}.` : ""}`,
  ``,
  `| Case | Result | Repairs | Files | Time | Cost | Notes |`,
  `|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${r.ok ? "pass" : "fail"} | ${r.repairs ?? "-"} | ${r.files ?? "-"} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "-"} | ${r.error ?? (r.failed?.length ? r.failed.join(", ") : r.folder)} |`),
  ``,
].join("\n");

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "eval-results.json"), JSON.stringify(summary, null, 2));
await fs.writeFile(path.join(outDir, "eval-report.md"), md);
console.log(`\n  ${summary.passed}/${summary.cases} passed · ${summary.totalRepairs} repair(s)${summary.costUsd != null ? ` · ~$${summary.costUsd.toFixed(4)}` : ""}`);
console.log(`  report: ${path.join(outDir, "eval-report.md")}`);
process.exit(summary.passed === summary.cases ? 0 : 2);
