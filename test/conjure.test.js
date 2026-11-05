import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conjure, slugify } from "../src/engine.js";
import { MockProvider } from "../src/providers.js";
import { Workspace, WorkspaceError } from "../src/workspace.js";
import { verifyWorkspace } from "../src/verify.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "conjure-test-"));

test("conjures a verified web app end to end (mock provider)", async () => {
  const out = await tmp();
  const events = [];
  const r = await conjure({ intent: "a click counter", provider: new MockProvider(), outDir: out, onEvent: (e) => events.push(e.type) });
  assert.equal(r.verification.ok, true);
  assert.equal(r.verification.repairs, 0);
  assert.deepEqual(r.files.sort(), ["README.md", "app.js", "index.html"]);
  const manifest = JSON.parse(await fs.readFile(path.join(r.workspace, "conjure.json"), "utf8"));
  assert.equal(manifest.intent, "a click counter");
  for (const t of ["phase", "plan", "file", "verify", "done"]) assert.ok(events.includes(t), `missing ${t} event`);
});

test("verify -> repair loop fixes an injected bug", async () => {
  const out = await tmp();
  const phases = [];
  const r = await conjure({
    intent: "a buggy counter",
    provider: new MockProvider({ flaw: true }),
    outDir: out,
    onEvent: (e) => e.type === "phase" && phases.push(e.phase),
  });
  assert.equal(r.verification.ok, true);
  assert.equal(r.verification.repairs, 1);
  assert.ok(phases.includes("repair"));
});

test("workspace rejects paths that escape the root", async () => {
  const ws = await new Workspace(await tmp()).init();
  for (const bad of ["../evil.txt", "..\\evil.txt", "/etc/passwd", "C:\\Windows\\x", ""]) {
    await assert.rejects(ws.write(bad, "x"), WorkspaceError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(await ws.write("nested/ok.txt", "hi"), "nested/ok.txt");
});

test("verifier catches syntax errors, bad JSON, missing files and weak HTML", async () => {
  const ws = await new Workspace(await tmp()).init();
  await ws.write("bad.js", "function (");
  await ws.write("bad.json", "{nope}");
  await ws.write("index.html", "<html><body><script>let x = ;</script></body></html>");
  const r = await verifyWorkspace(ws, ["missing.css"]);
  assert.equal(r.ok, false);
  const failed = r.results.filter((x) => !x.ok).map((x) => `${x.file}:${x.check}`);
  assert.ok(failed.includes("bad.js:js-syntax"));
  assert.ok(failed.includes("bad.json:json"));
  assert.ok(failed.includes("missing.css:exists"));
  assert.ok(failed.includes("index.html:html"));
  assert.ok(failed.includes("index.html#script1:js-syntax"));
});

test("engine rejects bad tool input and refusals", async () => {
  const out = await tmp();
  // Provider that sends malformed write_file input, then a valid build.
  let n = 0;
  const provider = {
    name: "fake", model: "fake",
    async turn({ jsonSchema, messages }) {
      if (jsonSchema) return { content: [{ type: "text", text: JSON.stringify({ name: "X", summary: "s", kind: "other", files: [{ path: "a.json", purpose: "p" }], acceptance: [] }) }], stop_reason: "end_turn" };
      n++;
      if (n === 1) return { content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "a.json" } }], stop_reason: "tool_use" };
      const last = messages.at(-1).content[0];
      assert.equal(last.is_error, true, "malformed input should produce an error result");
      return { content: [{ type: "tool_use", id: "t2", name: "write_file", input: { path: "a.json", contents: "{}" } }, { type: "tool_use", id: "t3", name: "finish", input: { summary: "ok" } }], stop_reason: "tool_use" };
    },
  };
  const r = await conjure({ intent: "json", provider, outDir: out });
  assert.equal(r.verification.ok, true);

  const refuser = { name: "r", model: "r", async turn() { return { content: [], stop_reason: "refusal", stop_details: { category: "cyber" } }; } };
  await assert.rejects(conjure({ intent: "x", provider: refuser, outDir: out }), /declined the plan step \(cyber\)/);
});

test("slugify", () => {
  assert.equal(slugify("Pomodoro Timer!"), "pomodoro-timer");
  assert.equal(slugify(""), "conjured");
});

test("ClaudeProvider sends the expected request shape", async () => {
  const { ClaudeProvider } = await import("../src/providers.js");
  let captured;
  const client = { beta: { messages: { stream(p) { captured = p; return { on() {}, finalMessage: async () => ({ content: [], stop_reason: "end_turn" }) }; } } } };
  const p = new ClaudeProvider({ client });
  await p.turn({ system: "s", messages: [{ role: "user", content: "hi" }], jsonSchema: { type: "object" }, effort: "medium" });
  assert.equal(captured.model, "claude-opus-5-5");
  assert.deepEqual(captured.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(captured.fallbacks, "default");
  assert.deepEqual(captured.output_config, { effort: "medium", format: { type: "json_schema", schema: { type: "object" } } });
  assert.equal(captured.thinking, undefined, "Opus 5.5 thinking is always on; no thinking param sent");
});

test("refine applies a change, re-verifies and records history", async () => {
  const { refine } = await import("../src/engine.js");
  const out = await tmp();
  const built = await conjure({ intent: "a notes app", provider: new MockProvider(), outDir: out });
  const r = await refine({ dir: built.workspace, change: "add a changelog", provider: new MockProvider() });
  assert.equal(r.refinement.ok, true);
  assert.ok(r.files.includes("CHANGELOG.md"));
  assert.equal(r.history.length, 1);
  const r2 = await refine({ dir: built.workspace, change: "second tweak", provider: new MockProvider() });
  assert.equal(r2.history.length, 2);
  await assert.rejects(refine({ dir: out, change: "x", provider: new MockProvider() }), /no conjure.json/);
});

test("cancelling aborts the run and still writes a transcript", async () => {
  const { ConjureCancelled } = await import("../src/engine.js");
  const out = await tmp();
  const controller = new AbortController();
  const events = [];
  const run = conjure({
    intent: "slow thing", provider: new MockProvider({ delayMs: 200 }), outDir: out, signal: controller.signal,
    onEvent: (e) => { events.push(e.type); if (e.type === "plan") controller.abort(); },
  });
  await assert.rejects(run, ConjureCancelled);
  assert.ok(events.includes("cancelled"));
  const [dir] = await fs.readdir(out);
  const lines = (await fs.readFile(path.join(out, dir, "transcript.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).type, "cancelled");
});

test("transcript coalesces streamed text and records every event", async () => {
  const out = await tmp();
  const r = await conjure({ intent: "a timer", provider: new MockProvider(), outDir: out });
  const lines = (await fs.readFile(path.join(r.workspace, "transcript.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([...new Set(lines.map((l) => l.type))].sort(), ["done", "file", "phase", "plan", "text", "verify"]);
});

test("model cannot overwrite Conjure's own files", async () => {
  const out = await tmp();
  let n = 0;
  const provider = {
    name: "fake", model: "fake",
    async turn({ jsonSchema, messages }) {
      if (jsonSchema) return { content: [{ type: "text", text: JSON.stringify({ name: "Y", summary: "s", kind: "other", files: [{ path: "a.txt", purpose: "p" }], acceptance: [] }) }], stop_reason: "end_turn" };
      if (++n === 1) return { content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "conjure.json", contents: "{}" } }], stop_reason: "tool_use" };
      assert.match(messages.at(-1).content[0].content, /reserved/);
      return { content: [{ type: "tool_use", id: "t2", name: "write_file", input: { path: "a.txt", contents: "hi" } }, { type: "tool_use", id: "t3", name: "finish", input: { summary: "ok" } }], stop_reason: "tool_use" };
    },
  };
  const r = await conjure({ intent: "x", provider, outDir: out });
  assert.equal(r.verification.ok, true);
});

test("verifier checks local links, imports and CSS", async () => {
  const ws = await new Workspace(await tmp()).init();
  await ws.write("index.html", `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>T</title>
<link rel="stylesheet" href="style.css"><link rel="icon" href="data:,"></head><body>
<a href="https://example.com">x</a><a href="#top">top</a><img src="img/missing.png"><a href="about/">about</a>
<script type="module" src="main.js"></script></body></html>`);
  await ws.write("style.css", "body { color: red; } .a { background: url('bg.png') }  .b { ");
  await ws.write("main.js", `import { x } from "./lib.js";\nimport y from "./gone.js";\nconsole.log(x, y);`);
  await ws.write("lib.js", "export const x = 1;");
  await ws.write("about/index.html", `<!doctype html><html><head><meta name="viewport" content="x"><title>A</title></head><body></body></html>`);
  const r = await verifyWorkspace(ws);
  const fail = Object.fromEntries(r.results.filter((x) => !x.ok).map((x) => [`${x.file}:${x.check}`, x.detail]));
  assert.match(fail["index.html:links"], /img\/missing\.png/);
  assert.doesNotMatch(fail["index.html:links"], /example|#top|data:|about\/|style\.css|main\.js/);
  assert.match(fail["style.css:css"], /unclosed/);
  assert.match(fail["style.css:links"], /bg\.png/);
  assert.match(fail["main.js:imports"], /gone\.js/);
  assert.doesNotMatch(fail["main.js:imports"], /lib\.js/);
  assert.equal(fail["about/index.html:links"], undefined);
});

test("cost estimate uses list prices", async () => {
  const { estimateCost } = await import("../src/pricing.js");
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };
  assert.equal(estimateCost("claude-opus-5-5", usage), 4 + 2 + 0.2);
  assert.equal(estimateCost("mock", usage), null);
});

test("zip packages a deliverable without its transcript", async () => {
  const { zipDeliverable, createZip } = await import("../src/zip.js");
  const zlib = await import("node:zlib");
  const out = await tmp();
  const r = await conjure({ intent: "a zip me app", provider: new MockProvider(), outDir: out });
  const z = await zipDeliverable(r.workspace);
  assert.ok(!z.files.includes("transcript.jsonl"));
  assert.ok(z.files.includes("conjure.json") && z.files.includes("index.html"));
  // Walk the central directory and inflate each entry back.
  const buf = z.buffer;
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26);
    const body = buf.subarray(start, start + csize);
    const raw = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(zlib.crc32(raw) >>> 0, crc, `crc mismatch for ${name}`);
    names.push(name);
    p += 46 + nlen;
  }
  assert.ok(names.every((n) => n.startsWith(path.basename(r.workspace) + "/")));
  assert.equal(createZip([]).length, 22, "empty archive is just the end record");
});

test("ClaudeProvider passes timeout and retry settings to the SDK client", async () => {
  const { ClaudeProvider } = await import("../src/providers.js");
  const p = new ClaudeProvider({ timeoutMs: 120000, maxRetries: 5 });
  assert.equal(p.client.timeout, 120000);
  assert.equal(p.client.maxRetries, 5);
  assert.equal(new ClaudeProvider().client.maxRetries, 3);
});

test("integer settings are validated with the setting's name", async () => {
  const { intEnv } = await import("../src/config.js");
  process.env.CONJURE_TEST_INT = "abc";
  assert.throws(() => intEnv("CONJURE_TEST_INT", 0), /CONJURE_TEST_INT must be an integer >= 0/);
  process.env.CONJURE_TEST_INT = "7";
  assert.equal(intEnv("CONJURE_TEST_INT", 1), 7);
  delete process.env.CONJURE_TEST_INT;
  assert.equal(intEnv("CONJURE_TEST_INT", 1), undefined);
});

test("verifier checks package.json entry points", async () => {
  const ws = await new Workspace(await tmp()).init();
  await ws.write("package.json", JSON.stringify({ name: "x", main: "index.js", bin: { tool: "bin/tool.js", gone: "./bin/gone.js" } }));
  await ws.write("index.js", "console.log(1)");
  await ws.write("bin/tool.js", "console.log(2)");
  const r = await verifyWorkspace(ws);
  const entry = r.results.find((x) => x.check === "entry");
  assert.equal(entry.ok, false);
  assert.match(entry.detail, /gone\.js/);
  assert.doesNotMatch(entry.detail, /index\.js|tool\.js/);
});
