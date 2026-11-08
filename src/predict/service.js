// Live prediction runs for "@conjure" mentions. Each run is the Nexus swarm engine
// (src/predict/vendor, synced from infinitum-nexus): build the world, run rounds, write a report.
// Runs are queued (CONJURE_PREDICT_CONCURRENCY at a time), saved to disk and streamed live.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createSimulation, step, writeReport, interview, estimateCalls, claudeComplete, ConjureError } from "./vendor/conjure.ts";
import { mockComplete, mockReportFetch } from "./mock.js";
import { openaiComplete, openaiAsAnthropicFetch } from "./openai.js";

const MAX_QUESTION = 500;
const MAX_CONTEXT = 30000;

function modelSetup({ mock, delayMs }) {
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const openUrl = (process.env.CONJURE_LLM_URL || "").replace(/\/+$/, "");
  const useMock = mock || process.env.CONJURE_MOCK === "1" || (!apiKey && !openUrl);
  if (useMock) return { mode: "mock", model: "mock", complete: mockComplete({ delayMs }), llm: { apiKey: "mock", model: "mock", fetchImpl: mockReportFetch() } };
  if (openUrl) {
    // An open-source model on an OpenAI-compatible server (Ollama by default) takes precedence.
    const model = process.env.CONJURE_LLM_MODEL || "qwen2.5:3b";
    const cfg = { baseUrl: openUrl, model, apiKey: process.env.CONJURE_LLM_KEY || "" };
    return { mode: "live", model, complete: openaiComplete(cfg), llm: { apiKey: "open", model, maxTokens: 3000, fetchImpl: openaiAsAnthropicFetch(cfg) } };
  }
  const model = process.env.CONJURE_PREDICT_MODEL || process.env.CONJURE_MODEL || "claude-opus-5-5";
  return { mode: "live", model, complete: claudeComplete({ apiKey, model }), llm: { apiKey, model, maxTokens: 3000 } };
}

/** What products and the dashboard see: no API internals, the feed trimmed to what matters. */
export function publicView(rec, { full = false } = {}) {
  const sim = rec.sim;
  const view = {
    id: rec.id, product: rec.product, user: rec.user, source: rec.source, status: rec.status, error: rec.error,
    question: rec.question, mode: rec.mode, createdAt: rec.createdAt, startedAt: rec.startedAt, finishedAt: rec.finishedAt,
    round: sim?.round ?? 0, rounds: sim?.rounds ?? rec.rounds, agents: sim?.personas.length ?? rec.agents,
    poles: sim?.poles, stats: sim?.stats ?? [], report: sim?.report ? { ...sim.report, steps: undefined } : undefined,
    calls: sim?.calls ?? 0, maxCalls: sim?.maxCalls,
  };
  if (full && sim) {
    view.summary = sim.seedSummary;
    view.entities = sim.entities;
    view.personas = sim.personas.map(({ memory: _m, ...p }) => p);
    view.feed = sim.feed.slice(-60);
  }
  return view;
}

export class PredictionService extends EventEmitter {
  constructor({ dir, concurrency = Number(process.env.CONJURE_PREDICT_CONCURRENCY || 2), delayMs = 0, onFinish } = {}) {
    super();
    this.setMaxListeners(200);
    this.dir = dir;
    this.concurrency = Math.max(1, concurrency);
    this.delayMs = delayMs;
    this.onFinish = onFinish;
    this.records = new Map();
    this.queue = [];
    this.running = 0;
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(this.dir, f), "utf8"));
        // A run cut off by a restart can't resume mid-round; mark it so callers aren't left waiting.
        if (rec.status === "queued" || rec.status === "running") Object.assign(rec, { status: "failed", error: "the server restarted during this run; start it again", finishedAt: new Date().toISOString() });
        this.records.set(rec.id, rec);
      } catch {}
    }
  }

  async save(rec) {
    const file = path.join(this.dir, `${rec.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    const { controller: _c, ...data } = rec;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  }

  get(id) {
    return this.records.get(id);
  }

  list({ product } = {}) {
    return [...this.records.values()].filter((r) => !product || r.product === product).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stats() {
    return { queued: this.queue.length, running: this.running, concurrency: this.concurrency };
  }

  /** Validates input and queues a run. Throws ConjureError for bad input. */
  async create({ product, user, source, question, context, agents, rounds, mock }) {
    const q = typeof question === "string" ? question.trim() : "";
    if (!q) throw new ConjureError("Ask a question after @conjure");
    if (q.length > MAX_QUESTION) throw new ConjureError(`Keep the question under ${MAX_QUESTION} characters`);
    if (context !== undefined && typeof context !== "string") throw new ConjureError("context must be text");
    if ((context ?? "").length > MAX_CONTEXT) throw new ConjureError(`Keep the context under ${MAX_CONTEXT} characters`);
    const a = Math.max(4, Math.min(60, Math.round(Number(agents) || 16)));
    const r = Math.max(1, Math.min(8, Math.round(Number(rounds) || 3)));
    const rec = {
      id: `pr_${crypto.randomBytes(9).toString("base64url")}`, product, user: typeof user === "string" ? user.slice(0, 120) : undefined,
      source: typeof source === "string" ? source.slice(0, 120) : undefined, question: q, context: (context ?? "").trim(),
      agents: a, rounds: r, mock: Boolean(mock), status: "queued", createdAt: new Date().toISOString(),
      estimate: estimateCalls(a, r).calls,
    };
    this.records.set(rec.id, rec);
    await this.save(rec);
    this.queue.push(rec);
    this.emitUpdate(rec);
    this.pump();
    return rec;
  }

  emitUpdate(rec) {
    this.emit(`update:${rec.id}`, publicView(rec));
    this.emit("update", rec);
  }

  cancel(rec) {
    if (rec.status === "queued") {
      this.queue = this.queue.filter((x) => x !== rec);
      Object.assign(rec, { status: "cancelled", finishedAt: new Date().toISOString() });
      this.save(rec).catch(() => {});
      this.emitUpdate(rec);
      return true;
    }
    if (rec.status === "running") {
      rec.controller?.abort();
      return true;
    }
    return false;
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const rec = this.queue.shift();
      this.running++;
      this.run(rec).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  async run(rec) {
    const setup = modelSetup({ mock: rec.mock, delayMs: this.delayMs });
    const controller = new AbortController();
    rec.controller = controller;
    rec.mode = setup.mode;
    rec.model = setup.model;
    rec.status = "running";
    rec.startedAt = new Date().toISOString();
    this.emitUpdate(rec);
    const checkCancel = () => {
      if (controller.signal.aborted) throw new ConjureError("cancelled");
    };
    try {
      let seed = rec.context;
      if (seed.length < 40) {
        // A bare "@conjure question" has no background: draft a neutral brief to seed the world.
        seed = await setup.complete(
          "You write a neutral background brief for a forecasting simulation: who is involved, the current situation, and the forces on each side. Don't forecast. Plain prose, 120-200 words.",
          `Question: ${rec.question}${seed ? `\nNotes: ${seed}` : ""}`,
          { maxTokens: 600 },
        );
        if (seed.trim().length < 40) seed = `${rec.question}\n\n${seed}`.padEnd(41, ".");
      }
      checkCancel();
      rec.sim = await createSimulation(setup.complete, { id: rec.id, question: rec.question, seed, agents: rec.agents, rounds: rec.rounds });
      this.emitUpdate(rec);
      await this.save(rec);
      while (rec.sim.status !== "done") {
        checkCancel();
        await step(setup.complete, rec.sim);
        this.emitUpdate(rec);
        await this.save(rec);
      }
      checkCancel();
      await writeReport(setup.llm, rec.sim);
      rec.status = "done";
    } catch (err) {
      if (controller.signal.aborted) rec.status = "cancelled";
      else {
        rec.status = "failed";
        rec.error = err instanceof ConjureError ? err.message : /API error 401/.test(err.message) ? "the model API key was refused" : err.message?.slice(0, 300) || "unexpected error";
        if (!(err instanceof ConjureError)) console.error(`prediction ${rec.id}:`, err);
      }
    } finally {
      delete rec.controller;
      rec.finishedAt = new Date().toISOString();
      rec.ms = Date.parse(rec.finishedAt) - Date.parse(rec.startedAt);
      await this.save(rec).catch(() => {});
      this.emitUpdate(rec);
      this.onFinish?.(rec);
    }
  }

  async ask(rec, agentId, question) {
    if (!rec.sim || rec.status !== "done") throw new ConjureError("Interview agents after the forecast finishes");
    const setup = modelSetup({ mock: rec.mock || rec.mode === "mock" });
    const q = typeof question === "string" ? question : "";
    const answer = await interview(setup.complete, rec.sim, String(agentId ?? ""), q, (rec.interviews ?? []).filter((x) => x.agentId === agentId));
    (rec.interviews ??= []).push({ agentId, q: q.slice(0, 1000), a: answer, at: new Date().toISOString() });
    await this.save(rec);
    return answer;
  }
}
