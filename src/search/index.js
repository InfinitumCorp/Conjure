// Conjure Search as a service: the model, Yandex search and the crawler wired together, with a short
// cache so a repeated question (a product retrying, a refreshed page) doesn't search and crawl twice.
import { modelSetup } from "../predict/service.js";
import { fetchPage } from "./crawl.js";
import { research, asBrief } from "./research.js";
import { searchConfigured, yandexSearch } from "./yandex.js";

const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;

export class SearchService {
  /** @param {{ search?: Function, fetchPage?: Function, complete?: Function, configured?: () => boolean }} [deps] tests swap these */
  constructor(deps = {}) {
    this.deps = deps;
    this.cache = new Map();
  }

  get configured() {
    return this.deps.configured ? this.deps.configured() : searchConfigured();
  }

  /** The model's one-shot completion, or null in mock mode (search needs a real model). */
  complete() {
    if (this.deps.complete) return this.deps.complete;
    const setup = modelSetup();
    return setup.mode === "mock" ? null : setup.complete;
  }

  /**
   * Answers a question from the web. Throws with a readable message when search isn't available.
   * @param {string} question
   * @param {{ onEvent?: (e: object) => void, signal?: AbortSignal, fresh?: boolean }} [o]
   */
  async ask(question, { onEvent = () => {}, signal, fresh = false } = {}) {
    if (!this.configured) throw Object.assign(new Error("Web search isn't switched on for this server."), { status: 503 });
    const complete = this.complete();
    if (!complete) throw Object.assign(new Error("Web search needs a live model; this server is in offline mode."), { status: 503 });
    const key = `${fresh ? "f:" : ""}${String(question).trim().toLowerCase().replace(/\s+/g, " ")}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      const r = { ...hit.result, cached: true };
      onEvent({ type: "sources", sources: r.sources });
      onEvent({ type: "answer", ...r });
      return r;
    }
    const result = await research(question, {
      complete,
      search: this.deps.search ?? ((q, o) => yandexSearch(q, o)),
      fetchPage: this.deps.fetchPage ?? fetchPage,
      onEvent,
      signal,
      fresh,
    });
    this.cache.set(key, { at: Date.now(), result });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  /** For forecasts: the research plus a plain-text brief to seed the simulation. */
  async brief(question, { signal } = {}) {
    const r = await this.ask(question, { signal });
    return { ...r, brief: asBrief(r) };
  }
}
