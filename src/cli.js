#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { conjure, refine, ConjureError, ConjureCancelled } from "./engine.js";
import { makeProvider, DEFAULT_OUT } from "./config.js";

const HELP = `conjure - turn an intent into a verified, working deliverable

Usage:
  conjure "<what to build>"            build something new
  conjure refine <dir> "<change>"      apply a change to an existing deliverable
  conjure zip <dir> [--out file.zip]   package a deliverable as a zip
  conjure list [--out <dir>]           list deliverables, newest first

Options:
  --mock     run offline with the scripted provider (default when no API credentials)
  --model    Claude model id (default claude-opus-5-5, or CONJURE_MODEL)
  --out      output directory for new builds (default ./conjured, or CONJURE_OUT)
  --flaw     (mock only) inject a bug to demo the verify -> repair loop
  --geo      turn geo routing on and save that choice (default off)
  --no-geo   turn geo routing off and save that choice
  -q         hide streamed model text
Press Ctrl+C to cancel a run.
Geo routing stays off until --geo or the settings toggle. Fetch datasets with: npm run geo:fetch`;

let geoFlag;
const args = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--geo") geoFlag = true;
  else if (arg === "--no-geo") geoFlag = false;
  else args.push(arg);
}

const { values, positionals } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    mock: { type: "boolean" },
    model: { type: "string" },
    out: { type: "string" },
    flaw: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    help: { type: "boolean", short: "h" },
  },
});

const isRefine = positionals[0] === "refine";
const isZip = positionals[0] === "zip";
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const { SettingsStore, conjureDataDir } = await import("./settings.js");
const { annotate, geoDataDir, geoEnabled } = await import("./geo.js");
const settings = await new SettingsStore(path.join(conjureDataDir(), "settings.json")).load();
if (geoFlag !== undefined) await settings.setGeoRouting(geoFlag);

if (positionals.length === 0) {
  if (geoFlag !== undefined) {
    console.log(settings.geoRouting ? "Geo routing is on." : "Geo routing is off.");
    process.exit(0);
  }
  console.log(HELP);
  process.exit(1);
}
if ((isRefine && positionals.length < 3) || (isZip && positionals.length !== 2)) {
  console.log(HELP);
  process.exit(1);
}

function reportGeo(text) {
  if (!geoEnabled(process.env, settings.geoRouting)) return;
  try {
    const found = annotate({ dir: geoDataDir(), text });
    if (found) console.log(dim(`  geo ${found.route}`));
  } catch (err) {
    console.log(dim(`  geo datasets unavailable (${err.message})`));
  }
}

if (positionals[0] === "list" && positionals.length === 1) {
  const fs = await import("node:fs/promises");
  const root = path.resolve(values.out ?? DEFAULT_OUT);
  const rows = [];
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    try {
      const m = JSON.parse(await fs.readFile(path.join(root, d.name, "conjure.json"), "utf8"));
      rows.push({ dir: d.name, m, at: m.history?.at(-1)?.at ?? m.createdAt });
    } catch {}
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (rows.length === 0) console.log(`No deliverables in ${root}`);
  for (const { dir, m, at } of rows) {
    const changes = m.history?.length ? ` +${m.history.length} change(s)` : "";
    const cost = m.costUsd != null ? ` ~$${m.costUsd.toFixed(4)}` : "";
    const when = new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    console.log(`${m.verification?.ok ? "✓" : "✗"} ${dir}  ${when}  ${m.provider}${cost}${changes}`);
    console.log(`  ${m.intent}`);
  }
  process.exit(0);
}

if (isZip) {
  const { zipDeliverable } = await import("./zip.js");
  const fs = await import("node:fs/promises");
  const dir = path.resolve(positionals[1]);
  try {
    await fs.access(path.join(dir, "conjure.json"));
  } catch {
    console.error(`Conjure: no conjure.json in ${dir}; zip works on folders Conjure created`);
    process.exit(1);
  }
  const z = await zipDeliverable(dir);
  const target = path.resolve(values.out ?? z.name);
  await fs.writeFile(target, z.buffer);
  console.log(`✓ ${target} (${z.files.length} files, ${(z.buffer.length / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

const provider = makeProvider({ mock: values.mock ? true : undefined, model: values.model, flaw: values.flaw });
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
  if (++interrupts > 1) process.exit(130);
  console.log(dim("\n  cancelling... (Ctrl+C again to force quit)"));
  controller.abort();
});

function onEvent(e) {
  if (e.type === "phase") console.log(`\n${bold("» " + e.phase)}${e.attempt ? ` #${e.attempt}` : ""}`);
  else if (e.type === "plan") {
    console.log(`  ${e.plan.name}: ${e.plan.summary}`);
    for (const f of e.plan.files) console.log(dim(`    · ${f.path} - ${f.purpose}`));
  } else if (e.type === "file") console.log(`  wrote ${e.path} ${dim(`(${e.bytes} B)`)}`);
  else if (e.type === "verify") {
    const failed = e.report.results.filter((r) => !r.ok);
    console.log(failed.length ? `  ✗ ${failed.length} check(s) failed` : `  ✓ ${e.report.results.length} checks passed`);
    for (const r of failed) console.log(dim(`    ${r.file} [${r.check}] ${r.detail}`));
  } else if (e.type === "text" && !values.quiet && e.phase === "forge") process.stdout.write(dim(e.text));
}

function stats(s) {
  const u = s.usage;
  const cost = s.costUsd == null ? "" : ` · ~$${s.costUsd.toFixed(4)}`;
  return `${(s.durationMs / 1000).toFixed(1)}s · ${u.input_tokens} in / ${u.output_tokens} out / ${u.cache_read_input_tokens} cached tokens${cost}`;
}

console.log(bold(`✦ Conjure`) + dim(`  provider=${provider.name} model=${provider.model}`));

try {
  if (isRefine) {
    const dir = path.resolve(positionals[1]);
    const change = positionals.slice(2).join(" ");
    reportGeo(change);
    const r = await refine({ dir, change, provider, signal: controller.signal, onEvent });
    const e = r.refinement;
    console.log(`\n${bold(e.ok ? "✓ Refined" : "⚠ Refined with failing checks")}: ${e.summary || e.change}`);
    console.log(`  ${r.workspace}`);
    console.log(dim(`  ${e.repairs} repair(s) · ${stats(e)} · ${r.history.length} change(s) so far`));
    process.exit(e.ok ? 0 : 2);
  } else {
    const intent = positionals.join(" ");
    reportGeo(intent);
    const r = await conjure({ intent, provider, outDir: values.out ?? DEFAULT_OUT, signal: controller.signal, onEvent });
    console.log(`\n${bold(r.verification.ok ? "✓ Conjured" : "⚠ Conjured with failing checks")}: ${r.summary || r.plan.name}`);
    console.log(`  ${r.workspace}`);
    console.log(dim(`  ${r.files.length} files · ${r.verification.repairs} repair(s) · ${stats(r)}`));
    process.exit(r.verification.ok ? 0 : 2);
  }
} catch (err) {
  if (err instanceof ConjureCancelled) console.error("Cancelled.");
  else if (err instanceof Anthropic.AuthenticationError) console.error("Authentication failed - check ANTHROPIC_API_KEY in .env, or run with --mock.");
  else if (err instanceof Anthropic.RateLimitError) console.error("Rate limited by the API - try again shortly.");
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else if (err instanceof ConjureError) console.error(`Conjure: ${err.message}`);
  else throw err;
  process.exit(err instanceof ConjureCancelled ? 130 : 1);
}
