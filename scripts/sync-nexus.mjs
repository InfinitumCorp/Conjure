#!/usr/bin/env node
// Copies the Conjure prediction engine from Infinitum Nexus (the source of truth) into
// src/predict/vendor/, so the hosted service runs exactly the code products import.
//   node scripts/sync-nexus.mjs [path-to-infinitum-nexus]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nexus = path.resolve(process.argv[2] || path.join(root, "..", "github", "infinitum-nexus"));
const out = path.join(root, "src", "predict", "vendor");
const files = [
  ["packages/conjure/src/conjure.ts", "conjure.ts", (s) => s.replace(`from "@infinitum/scalus"`, `from "./llm.ts"`)],
  ["packages/scalus/src/llm.ts", "llm.ts", (s) => s],
];

fs.mkdirSync(out, { recursive: true });
let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", nexus, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {}
for (const [from, to, fix] of files) {
  const src = fs.readFileSync(path.join(nexus, from), "utf8");
  const text = fix(src);
  if (to === "conjure.ts" && text.includes("@infinitum/")) throw new Error("conjure.ts gained a new workspace import; update sync-nexus.mjs");
  fs.writeFileSync(path.join(out, to), `// Synced from infinitum-nexus ${from} @ ${commit}. Do not edit here; edit Nexus and re-run scripts/sync-nexus.mjs.\n${text}`);
}
fs.writeFileSync(path.join(out, "SOURCE.json"), JSON.stringify({ repo: "InfinitumCorp/infinitum-nexus", commit, files: files.map((f) => f[0]) }, null, 2) + "\n");
console.log(`synced ${files.length} files from infinitum-nexus @ ${commit}`);
