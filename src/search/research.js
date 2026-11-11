// Conjure Search: answers a question from the live web, with numbered citations.
//
//   1. plan    the model turns the question into 1-3 web searches
//   2. search  Yandex Search API (in Russia); results are merged and de-duplicated
//   3. read    the top pages are fetched (public addresses only) and cut into passages
//   4. rank    passages are scored against the question (BM25), at most 3 per page
//   5. answer  the model writes the answer from those passages only, citing them as [1], [2]…
//
// Every step reports progress through onEvent, so callers can stream it.

const MAX_PAGES = 6;
const MAX_PASSAGES = 14;
const PASSAGE_CHARS = 900;

const STOP = new Set(("a an and are as at be by for from has have how in is it its of on or that the this to was what when where which who why will with " +
  "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну " +
  "ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам " +
  "чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда " +
  "зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою " +
  "этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между").split(" "));

/** Lowercase word stems (first 6 letters), stop words removed. Good enough for Russian and English ranking. */
export function terms(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.slice(0, 6));
}

/** Cuts page text into passages of about PASSAGE_CHARS, on paragraph then sentence boundaries. */
export function passages(text) {
  const out = [];
  let cur = "";
  for (const para of String(text).split(/\n+/)) {
    const p = para.trim();
    if (p.length < 30) continue;
    for (const piece of p.length > PASSAGE_CHARS ? p.match(/[^.!?…]+[.!?…]*\s*/g) ?? [p] : [p]) {
      if (cur && cur.length + piece.length > PASSAGE_CHARS) {
        out.push(cur.trim());
        cur = "";
      }
      cur += (cur ? " " : "") + piece.trim();
    }
  }
  if (cur.trim().length >= 30) out.push(cur.trim());
  return out.slice(0, 400);
}

/** BM25 over all passages; returns them best first. */
export function rank(query, items) {
  const q = [...new Set(terms(query))];
  if (!q.length) return items.map((it) => ({ ...it, score: 0 }));
  const docs = items.map((it) => terms(it.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return items
    .map((it, i) => {
      const d = docs[i];
      let score = 0;
      for (const t of q) {
        const f = d.filter((w) => w === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / (avg || 1)));
      }
      return { ...it, score };
    })
    .sort((x, y) => y.score - x.score);
}

/** Runs tasks with at most `n` at a time; failures resolve to null. */
async function pool(items, n, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  }));
  return out;
}

function parseQueries(text, question) {
  try {
    const m = /\[[\s\S]*\]/.exec(text);
    const list = JSON.parse(m ? m[0] : text);
    const qs = (Array.isArray(list) ? list : list.queries ?? []).map((q) => String(q).trim()).filter((q) => q && q.length <= 200);
    if (qs.length) return [...new Set(qs)].slice(0, 3);
  } catch {}
  return [question.slice(0, 200)];
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Researches a question on the web.
 * @param {string} question
 * @param {object} deps
 * @param {(system: string, user: string, opts?: object) => Promise<string>} deps.complete the model
 * @param {(q: string, o?: object) => Promise<Array<{url,title,snippet,domain}>>} deps.search
 * @param {(url: string, o?: object) => Promise<{url,title,text}>} deps.fetchPage
 * @param {(e: object) => void} [deps.onEvent]
 * @param {AbortSignal} [deps.signal]
 * @param {boolean} [deps.fresh] prefer recent results
 * @returns {Promise<{ question, queries, answer, sources: Array<{n,url,title,domain,snippet,read}> }>}
 */
export async function research(question, { complete, search, fetchPage, onEvent = () => {}, signal, fresh = false } = {}) {
  question = String(question ?? "").trim().slice(0, 1000);
  if (question.length < 3) throw new Error("Ask a question (3 characters or more).");

  // 1. plan
  onEvent({ type: "status", step: "plan", message: "Planning searches" });
  let queries;
  try {
    queries = parseQueries(await complete(
      `You turn a question into web searches. Today is ${today()}. Reply with a JSON array of 1 to 3 short search queries, in the question's language, that together find what's needed to answer it (add an English query when sources are likely to be in English). JSON only.`,
      question,
      { maxTokens: 200 },
    ), question);
  } catch {
    queries = [question.slice(0, 200)];
  }
  onEvent({ type: "queries", queries });

  // 2. search
  onEvent({ type: "status", step: "search", message: "Searching the web" });
  const lists = await Promise.all(queries.map((q) => search(q, { count: 8, fresh, signal }).catch((err) => (onEvent({ type: "warning", message: err.message }), []))));
  const seen = new Set();
  const results = [];
  // Interleave the queries' results so each query's best hits come first.
  for (let i = 0; i < 10; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r) continue;
      const key = r.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
    }
  }
  if (!results.length) {
    const failed = lists.every((l) => !l.length);
    throw new Error(failed ? "The web search found nothing for this question." : "No usable results.");
  }
  const sources = results.slice(0, 10).map((r, i) => ({ n: i + 1, url: r.url, title: r.title, domain: r.domain, snippet: r.snippet, read: false }));
  onEvent({ type: "sources", sources });

  // 3. read
  onEvent({ type: "status", step: "read", message: `Reading ${Math.min(MAX_PAGES, sources.length)} pages` });
  const pages = await pool(sources.slice(0, MAX_PAGES), 4, (s) => fetchPage(s.url, { signal }));
  const items = [];
  sources.forEach((s, i) => {
    const page = pages[i];
    if (page?.text && page.text.length > 200) {
      s.read = true;
      for (const text of passages(page.text)) items.push({ n: s.n, text });
    }
    // A page that couldn't be read still counts through its search snippet.
    if (s.snippet) items.push({ n: s.n, text: s.snippet, snippet: true });
  });
  onEvent({ type: "read", read: sources.filter((s) => s.read).map((s) => s.n) });

  // 4. rank
  const ranked = rank(`${question} ${queries.join(" ")}`, items);
  const perSource = new Map();
  const chosen = [];
  for (const p of ranked) {
    if (chosen.length >= MAX_PASSAGES) break;
    const k = perSource.get(p.n) ?? 0;
    if (k >= 3) continue;
    perSource.set(p.n, k + 1);
    chosen.push(p);
  }
  chosen.sort((x, y) => x.n - y.n);

  // 5. answer
  onEvent({ type: "status", step: "answer", message: "Writing the answer" });
  const context = chosen.map((p) => `[${p.n}] ${sources[p.n - 1].title} (${sources[p.n - 1].domain})\n${p.text}`).join("\n\n");
  const answer = (await complete(
    `You are Conjure Search. Answer the question using only the numbered sources below. Today is ${today()}.
Rules:
- Write in the question's language. Lead with the direct answer, then the key details. Use short paragraphs or bullets; no headings unless the answer is long.
- Cite every factual sentence with the source numbers in square brackets, like [2] or [1][4]. Only cite numbers that appear below.
- If sources disagree, say so and cite both. If they don't contain the answer, say what is known and what isn't. Never invent facts, numbers or dates.
- Prefer recent and primary sources. Keep it under 250 words unless the question needs more.`,
    `Question: ${question}\n\nSources:\n${context}`,
    { maxTokens: 1500 },
  )).trim();
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const result = { question, queries, answer, sources: sources.map((s) => ({ ...s, cited: cited.has(s.n) })) };
  onEvent({ type: "answer", ...result });
  return result;
}

/** A research result as plain text: the background brief a forecast starts from. */
export function asBrief(r) {
  return `${r.answer}\n\nSources:\n${r.sources.filter((s) => s.cited || s.read).map((s) => `[${s.n}] ${s.title}: ${s.url}`).join("\n")}`;
}
