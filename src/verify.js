// Verifier: deterministic checks run against the conjured workspace.
// Failures are fed back to the model so it can repair its own output.
import { spawn } from "node:child_process";
import path from "node:path";

function nodeCheck(file, root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      // Keep only the useful part: "file:line", the source excerpt and the error line,
      // with workspace-relative paths and no ANSI colour codes or internal stack frames.
      const detail = stderr
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .filter((l) => !/^\s+at /.test(l) && l.trim() !== "")
        .map((l) => l.split(root + path.sep).join("").split(root).join(""))
        .slice(0, 4)
        .join("\n");
      resolve({ ok: code === 0, detail });
    });
  });
}

function checkHtml(src) {
  const problems = [];
  if (!/<html[\s>]/i.test(src)) problems.push("missing <html> element");
  if (!/<\/html>\s*$/i.test(src.trim())) problems.push("document does not end with </html>");
  if (!/<title>[^<]+<\/title>/i.test(src)) problems.push("missing or empty <title>");
  if (!/<meta[^>]+viewport/i.test(src)) problems.push("missing viewport meta tag");
  const opens = (src.match(/<script\b/gi) || []).length;
  const closes = (src.match(/<\/script>/gi) || []).length;
  if (opens !== closes) problems.push(`unbalanced <script> tags (${opens} open, ${closes} close)`);
  return problems;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|$)/i; // http:, data:, mailto:, //cdn, #anchor, empty

/** Local references in an HTML file: src/href attributes plus url(...) in inline styles. */
function htmlRefs(src) {
  const refs = [];
  const attr = /<(?:script|link|img|a|source|iframe|audio|video|track|embed|use|image)\b[^>]*?\s(?:src|href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = attr.exec(src))) refs.push(m[2]);
  return refs;
}

/** Relative module imports in a JS file. */
function jsRefs(src) {
  const refs = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
  let m;
  while ((m = re.exec(src))) refs.push(m[2]);
  return refs;
}

/** Local url(...) references in CSS. */
function cssRefs(src) {
  const refs = [];
  const re = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(src))) refs.push(m[2].trim());
  return refs;
}

/** Returns the refs that point to local files that don't exist. */
function missingRefs(fromFile, refs, files) {
  const missing = [];
  const baseDir = path.posix.dirname(fromFile);
  for (const raw of refs) {
    const ref = raw.trim();
    if (EXTERNAL.test(ref) || ref.includes("${") || ref.includes("{{")) continue;
    let clean = ref.split(/[?#]/)[0];
    try {
      clean = decodeURI(clean);
    } catch {}
    if (!clean) continue;
    const target = path.posix.normalize(clean.startsWith("/") ? clean.slice(1) : path.posix.join(baseDir, clean));
    if (target.startsWith("..")) {
      missing.push(`${ref} (outside the deliverable)`);
      continue;
    }
    const isDir = target.endsWith("/") || target === ".";
    const candidates = isDir ? [path.posix.join(target, "index.html")] : [target];
    if (!candidates.some((c) => files.includes(c))) missing.push(ref);
  }
  return [...new Set(missing)];
}

function checkCss(src) {
  const problems = [];
  const opens = (src.match(/\/\*/g) || []).length;
  const closes = (src.match(/\*\//g) || []).length;
  if (opens > closes) problems.push("unterminated /* comment");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) break;
  }
  if (depth !== 0) problems.push(depth > 0 ? `${depth} unclosed {` : "unexpected }");
  return problems;
}

function extractInlineScripts(src) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!module|text\/javascript)/i.test(attrs)) continue;
    scripts.push({ module: /type\s*=\s*["']module/i.test(attrs), code: m[2] });
  }
  return scripts;
}

/**
 * Run all checks. Returns { ok, results: [{file, check, ok, detail}] }.
 * `expected` is the list of files the plan promised.
 */
export async function verifyWorkspace(workspace, expected = []) {
  const files = await workspace.list();
  const results = [];

  for (const f of expected) {
    if (!files.includes(f)) results.push({ file: f, check: "exists", ok: false, detail: "planned file was not written" });
  }
  if (files.length === 0) results.push({ file: "*", check: "exists", ok: false, detail: "no files were written" });

  for (const f of files) {
    const full = workspace.resolve(f);
    const ext = path.extname(f).toLowerCase();
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const r = await nodeCheck(full, workspace.root);
      results.push({ file: f, check: "js-syntax", ...r });
      const missing = missingRefs(f, jsRefs(await workspace.read(f)), files);
      if (missing.length) results.push({ file: f, check: "imports", ok: false, detail: `imports missing files: ${missing.join(", ")}` });
    } else if (ext === ".css") {
      const src = await workspace.read(f);
      const problems = checkCss(src);
      results.push({ file: f, check: "css", ok: problems.length === 0, detail: problems.join("; ") });
      const missing = missingRefs(f, cssRefs(src), files);
      if (missing.length) results.push({ file: f, check: "links", ok: false, detail: `url() points to missing files: ${missing.join(", ")}` });
    } else if (ext === ".json") {
      let parsed;
      try {
        parsed = JSON.parse(await workspace.read(f));
        results.push({ file: f, check: "json", ok: true, detail: "" });
      } catch (e) {
        results.push({ file: f, check: "json", ok: false, detail: e.message });
      }
      if (parsed && path.posix.basename(f) === "package.json") {
        // Entry points named in package.json must exist.
        const entries = [];
        if (typeof parsed.main === "string") entries.push(parsed.main);
        if (typeof parsed.bin === "string") entries.push(parsed.bin);
        else if (parsed.bin && typeof parsed.bin === "object") entries.push(...Object.values(parsed.bin).filter((v) => typeof v === "string"));
        const missing = missingRefs(f, entries.map((e) => (e.startsWith(".") ? e : `./${e}`)), files);
        results.push({ file: f, check: "entry", ok: missing.length === 0, detail: missing.length ? `main/bin point to missing files: ${missing.join(", ")}` : "" });
      }
    } else if (ext === ".html" || ext === ".htm") {
      const src = await workspace.read(f);
      const problems = checkHtml(src);
      results.push({ file: f, check: "html", ok: problems.length === 0, detail: problems.join("; ") });
      const missing = missingRefs(f, htmlRefs(src), files);
      results.push({ file: f, check: "links", ok: missing.length === 0, detail: missing.length ? `points to missing files: ${missing.join(", ")}` : "" });
      const scripts = extractInlineScripts(src);
      for (let i = 0; i < scripts.length; i++) {
        const tmp = `.conjure-check/${path.basename(f)}.${i}.${scripts[i].module ? "mjs" : "js"}`;
        await workspace.write(tmp, scripts[i].code);
        const r = await nodeCheck(workspace.resolve(tmp), workspace.root);
        results.push({ file: `${f}#script${i + 1}`, check: "js-syntax", ...r });
      }
    }
  }

  // Clean up temp check files.
  const { rm } = await import("node:fs/promises");
  await rm(path.join(workspace.root, ".conjure-check"), { recursive: true, force: true });

  return { ok: results.every((r) => r.ok), results };
}

export function formatFailures(report) {
  return report.results
    .filter((r) => !r.ok)
    .map((r) => `- ${r.file} [${r.check}]: ${r.detail || "failed"}`)
    .join("\n");
}
